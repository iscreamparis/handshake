// PlayerStore on top of a TableApi (the EtcitoGameServer tenant tables).
// No read-modify-write on shared state: every fact is an append-only row guarded by a unique key
// (tx_id, match_id, ev_key, open_key), and current state (balance, packs, rating) is derived from rows.
// A per-key mutex serialises the check-then-insert steps inside this process (one Handshake instance).

import { randomUUID } from 'node:crypto'
import { StoreError } from './errors.ts'
import { DEFAULT_ELO, nextRating, tierOf } from './elo.ts'
import type { EloParams } from './elo.ts'
import type { Filter, Row, TableApi } from './tables.ts'
import type { OpenPackResult, PacksResult, Player, PlayerStore, RankedResult, WalletResult } from './types.ts'

const PAGE = 500
const LEADERBOARD_PAGE_SIZE = 50
const T = { players: 'etc_players', ids: 'etc_identities', locks: 'etc_locks', results: 'etc_ranked_results', events: 'etc_rating_events', ledger: 'etc_ledger' }

function stringArgument(value: unknown, name: string, max = Infinity): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new StoreError('bad_argument', `Invalid ${name}`)
}
function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new StoreError('bad_argument', `Invalid ${name}`)
}

export function createHttpPlayerStore(api: TableApi, opts: { now?: () => number; uuid?: () => string; elo?: () => EloParams } = {}): PlayerStore {
  const now = opts.now ?? Date.now
  const uuid = opts.uuid ?? randomUUID
  /** Rating parameters of the game, read at each use so a refreshed etc_game applies without a restart. */
  const elo = opts.elo ?? (() => DEFAULT_ELO)
  const tails = new Map<string, Promise<unknown>>()

  async function locked<R>(keys: string[], fn: () => Promise<R>): Promise<R> {
    const sorted = [...new Set(keys)].sort()
    const run = async (i: number): Promise<R> => {
      if (i === sorted.length) return fn()
      const key = sorted[i]!
      const prev = tails.get(key) ?? Promise.resolve()
      const mine = prev.then(() => run(i + 1), () => run(i + 1))
      const tail = mine.catch(() => undefined)
      tails.set(key, tail)
      try { return await mine } finally { if (tails.get(key) === tail) tails.delete(key) }
    }
    return run(0)
  }

  async function all(table: string, filters: Filter[], sort?: { field: string; dir: 'asc' | 'desc' }[]): Promise<Row[]> {
    const out: Row[] = []
    for (let page = 1; ; page++) {
      const rows = await api.query(table, { filters, sort, page, size: PAGE })
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }
  const one = async (table: string, filters: Filter[]) => (await api.query(table, { filters, size: 1 }))[0]

  async function loadPlayer(playerId: string): Promise<Player | null> {
    const row = await one(T.players, [{ field: 'player_id', op: 'eq', value: playerId }])
    if (!row) return null
    const ids = await all(T.ids, [{ field: 'player_id', op: 'eq', value: playerId }])
    const lock = await one(T.locks, [{ field: 'open_key', op: 'eq', value: playerId }])
    return {
      player_id: playerId,
      display_name: row.display_name as string,
      kind: row.kind as Player['kind'],
      identities: ids.map(r => {
        const [provider, ...rest] = String(r.ident_key).split('\u001f')
        return { provider: provider as Player['identities'][number]['provider'], external_id: rest.join('\u001f') }
      }),
      active_ranked_match: lock ? (lock.match_id as string) : null,
      created_at: row.created_at as number,
    }
  }
  async function requirePlayer(playerId: string): Promise<Player> {
    stringArgument(playerId, 'player id')
    const p = await loadPlayer(playerId)
    if (!p) throw new StoreError('not_found', 'Player not found')
    return p
  }

  async function repeat<R>(op: string, player: string, params: string, txId: string): Promise<R | undefined> {
    const row = await one(T.ledger, [{ field: 'tx_id', op: 'eq', value: txId }])
    if (!row) return undefined
    if (row.op !== op || row.player_id !== player || row.params !== params) {
      throw new StoreError('tx_conflict', 'Transaction id already used with different parameters')
    }
    return { ...JSON.parse(row.result_json as string), applied: false } as R
  }
  async function append(row: Row & { tx_id: string; op: string; player_id: string; params: string }, result: unknown): Promise<boolean> {
    const r = await api.insert(T.ledger, { game: '', coin_delta: 0, pack_delta: 0, created_at: now(), ...row, result_json: JSON.stringify(result) })
    return r !== 'conflict'
  }
  async function sum(playerId: string, field: 'coin_delta' | 'pack_delta', game?: string): Promise<number> {
    const filters: Filter[] = [{ field: 'player_id', op: 'eq', value: playerId }]
    if (game !== undefined) filters.push({ field: 'game', op: 'eq', value: game })
    return (await all(T.ledger, filters)).reduce((n, r) => n + (Number(r[field]) || 0), 0)
  }
  async function ratingOf(playerId: string, game: string): Promise<{ rating: number; games: number }> {
    const ev = (await api.query(T.events, {
      filters: [{ field: 'player_id', op: 'eq', value: playerId }, { field: 'game', op: 'eq', value: game }],
      sort: [{ field: 'id', dir: 'desc' }], size: 1,
    }))[0]
    return ev ? { rating: ev.r_after as number, games: ev.games as number } : { rating: elo().start, games: 0 }
  }

  async function changeWallet(op: 'credit' | 'debit', playerId: string, amount: number, reason: string, txId: string): Promise<WalletResult> {
    positiveInteger(amount, 'amount')
    stringArgument(reason, 'reason', 64)
    stringArgument(txId, 'transaction id', 128)
    await requirePlayer(playerId)
    const params = JSON.stringify([amount, reason])
    return locked([`p:${playerId}`], async () => {
      const previous = await repeat<WalletResult>(op, playerId, params, txId)
      if (previous) return previous
      const balance = await sum(playerId, 'coin_delta')
      if (op === 'debit' && amount > balance) throw new StoreError('insufficient_funds', 'Insufficient funds')
      const result = { balance: balance + (op === 'credit' ? amount : -amount), applied: true }
      if (!(await append({ tx_id: txId, op, player_id: playerId, params, coin_delta: op === 'credit' ? amount : -amount }, result))) {
        const raced = await repeat<WalletResult>(op, playerId, params, txId)
        if (raced) return raced
        throw new StoreError('tx_conflict', 'Transaction id already used')
      }
      return result
    })
  }

  return {
    async getOrCreateByIdentity(identity, init) {
      if (!identity || !['wavedash', 'itch', 'guest'].includes(identity.provider)) throw new StoreError('bad_argument', 'Invalid identity provider')
      stringArgument(identity.external_id, 'external id', 256)
      const kind = init?.kind ?? 'human'
      if (kind !== 'human' && kind !== 'resident') throw new StoreError('bad_argument', 'Invalid player kind')
      const identKey = `${identity.provider}\u001f${identity.external_id}`
      return locked([`i:${identKey}`], async () => {
        let created = false
        let ident = await one(T.ids, [{ field: 'ident_key', op: 'eq', value: identKey }])
        if (!ident) {
          const claimed = await api.insert(T.ids, { ident_key: identKey, player_id: uuid() })
          if (claimed === 'conflict') ident = await one(T.ids, [{ field: 'ident_key', op: 'eq', value: identKey }])
          else { ident = claimed.row; created = true }
        }
        if (!ident) throw new Error('identity claim failed')
        const playerId = ident.player_id as string
        if (!(await one(T.players, [{ field: 'player_id', op: 'eq', value: playerId }]))) {
          const name = typeof init?.display_name === 'string' ? init.display_name.trim() : ''
          await api.insert(T.players, {
            player_id: playerId, kind, created_at: now(),
            display_name: name.length >= 3 && name.length <= 16 ? name : `Player-${playerId.slice(0, 4)}`,
          })
        }
        return { player: (await loadPlayer(playerId))!, created }
      })
    },

    async getPlayer(playerId) {
      stringArgument(playerId, 'player id')
      return loadPlayer(playerId)
    },

    async getRating(playerId, game) {
      await requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      const r = await ratingOf(playerId, game)
      return { game, ...r, placement: r.games < elo().placementGames }
    },

    async applyRankedResult(outcome) {
      if (!outcome) throw new StoreError('bad_argument', 'Invalid ranked outcome')
      const { match_id, game, a, b, score_a } = outcome
      stringArgument(match_id, 'match id')
      stringArgument(game, 'game', 64)
      stringArgument(a, 'player a')
      stringArgument(b, 'player b')
      if (a === b || (score_a !== 0 && score_a !== 0.5 && score_a !== 1)) throw new StoreError('bad_argument', 'Invalid ranked players or score')
      const stored = async (): Promise<RankedResult | undefined> => {
        const row = await one(T.results, [{ field: 'match_id', op: 'eq', value: match_id }])
        return row ? { ...JSON.parse(row.result_json as string), applied: false } : undefined
      }
      const before = await stored()
      if (before) return before
      await requirePlayer(a)
      await requirePlayer(b)
      return locked([`p:${a}`, `p:${b}`], async () => {
        const params = elo()
        const again = await stored()
        if (again) return again
        const ba = await ratingOf(a, game), bb = await ratingOf(b, game)
        const aa = { rating: nextRating(ba.rating, bb.rating, score_a, ba.games, params), games: ba.games + 1 }
        const ab = { rating: nextRating(bb.rating, ba.rating, (1 - score_a) as 0 | 0.5 | 1, bb.games, params), games: bb.games + 1 }
        const result: RankedResult = {
          match_id, game, applied: true,
          a: { player_id: a, before: ba.rating, after: aa.rating, games: aa.games, placement: aa.games < params.placementGames },
          b: { player_id: b, before: bb.rating, after: ab.rating, games: ab.games, placement: ab.games < params.placementGames },
        }
        const claimed = await api.insert(T.results, { match_id, result_json: JSON.stringify(result) })
        if (claimed === 'conflict') return (await stored())!
        for (const c of [result.a, result.b]) {
          await api.insert(T.events, { ev_key: `${match_id}\u001f${c.player_id}`, player_id: c.player_id, game, match_id, r_before: c.before, r_after: c.after, games: c.games })
        }
        for (const id of [a, b]) {
          const lock = await one(T.locks, [{ field: 'open_key', op: 'eq', value: id }])
          if (lock && lock.match_id === match_id) await api.update(T.locks, lock.id as number, { open_key: null })
        }
        return result
      })
    },

    async lockRanked(playerId, matchId) {
      stringArgument(playerId, 'player id')
      stringArgument(matchId, 'match id')
      if (!(await loadPlayer(playerId))) return false
      return locked([`p:${playerId}`], async () => {
        const r = await api.insert(T.locks, { player_id: playerId, match_id: matchId, open_key: playerId })
        if (r !== 'conflict') return true
        const open = await one(T.locks, [{ field: 'open_key', op: 'eq', value: playerId }])
        return open?.match_id === matchId
      })
    },

    async unlockRanked(playerId, matchId) {
      stringArgument(playerId, 'player id')
      stringArgument(matchId, 'match id')
      return locked([`p:${playerId}`], async () => {
        const open = await one(T.locks, [{ field: 'open_key', op: 'eq', value: playerId }])
        if (!open || open.match_id !== matchId) return false
        await api.update(T.locks, open.id as number, { open_key: null })
        return true
      })
    },

    async balance(playerId) {
      await requirePlayer(playerId)
      return sum(playerId, 'coin_delta')
    },
    credit: (playerId, amount, reason, txId) => changeWallet('credit', playerId, amount, reason, txId),
    debit: (playerId, amount, reason, txId) => changeWallet('debit', playerId, amount, reason, txId),

    async unopenedPacks(playerId, game) {
      await requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      return sum(playerId, 'pack_delta', game)
    },

    async addPacks(playerId, game, count, reason, txId): Promise<PacksResult> {
      await requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      positiveInteger(count, 'pack count')
      stringArgument(reason, 'reason', 64)
      stringArgument(txId, 'transaction id', 128)
      const params = JSON.stringify([game, count, reason])
      return locked([`p:${playerId}`], async () => {
        const previous = await repeat<PacksResult>('addPacks', playerId, params, txId)
        if (previous) return previous
        const result = { unopened: (await sum(playerId, 'pack_delta', game)) + count, applied: true }
        if (!(await append({ tx_id: txId, op: 'addPacks', player_id: playerId, params, game, pack_delta: count }, result))) {
          const raced = await repeat<PacksResult>('addPacks', playerId, params, txId)
          if (raced) return raced
          throw new StoreError('tx_conflict', 'Transaction id already used')
        }
        return result
      })
    },

    async openPack(playerId, game, roller, txId): Promise<OpenPackResult> {
      await requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      stringArgument(txId, 'transaction id', 128)
      const params = JSON.stringify([game])
      return locked([`p:${playerId}`], async () => {
        const previous = await repeat<OpenPackResult>('openPack', playerId, params, txId)
        if (previous) return previous
        if (typeof roller !== 'function') throw new StoreError('bad_argument', 'Invalid pack roller')
        const unopened = await sum(playerId, 'pack_delta', game)
        if (unopened <= 0) throw new StoreError('no_packs', 'No unopened packs')
        const rolled = await roller(playerId, game)
        if (!Array.isArray(rolled) || rolled.length < 1 || rolled.length > 64) throw new StoreError('bad_argument', 'A pack must contain 1..64 cards')
        const cards = [...rolled]
        for (const card of cards) stringArgument(card, 'card id')
        const result = { cards, remaining: unopened - 1, applied: true }
        if (!(await append({ tx_id: txId, op: 'openPack', player_id: playerId, params, game, pack_delta: -1 }, result))) {
          const raced = await repeat<OpenPackResult>('openPack', playerId, params, txId)
          if (raced) return raced
          throw new StoreError('tx_conflict', 'Transaction id already used')
        }
        return result
      })
    },

    async collection(playerId, game) {
      await requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      const rows = await all(T.ledger, [{ field: 'player_id', op: 'eq', value: playerId }, { field: 'game', op: 'eq', value: game }, { field: 'op', op: 'eq', value: 'openPack' }])
      const out: Record<string, number> = {}
      for (const r of rows) for (const card of (JSON.parse(r.result_json as string) as { cards: string[] }).cards) out[card] = (out[card] ?? 0) + 1
      return out
    },

    async leaderboard(game, page) {
      stringArgument(game, 'game', 64)
      positiveInteger(page, 'page')
      const events = await all(T.events, [{ field: 'game', op: 'eq', value: game }], [{ field: 'id', dir: 'desc' }])
      const latest = new Map<string, { rating: number; games: number }>()
      for (const e of events) if (!latest.has(e.player_id as string)) latest.set(e.player_id as string, { rating: e.r_after as number, games: e.games as number })
      const ranked = [...latest].filter(([, r]) => r.games >= elo().placementGames)
      const names = new Map<string, string>()
      const ids = ranked.map(([id]) => id)
      for (let i = 0; i < ids.length; i += 200) {
        for (const p of await api.query(T.players, { filters: [{ field: 'player_id', op: 'in', values: ids.slice(i, i + 200) }], size: 200 })) names.set(p.player_id as string, p.display_name as string)
      }
      const entries = ranked.map(([player_id, r]) => ({ player_id, display_name: names.get(player_id) ?? '', ...r, tier: tierOf(r.rating) }))
      entries.sort((x, y) => y.rating - x.rating || (x.player_id < y.player_id ? -1 : x.player_id > y.player_id ? 1 : 0))
      const start = (page - 1) * LEADERBOARD_PAGE_SIZE
      return {
        game, page, page_size: LEADERBOARD_PAGE_SIZE, total: entries.length,
        entries: entries.slice(start, start + LEADERBOARD_PAGE_SIZE).map((e, i) => ({ rank: start + i + 1, ...e })),
      }
    },
  }
}
