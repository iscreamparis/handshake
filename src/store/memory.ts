import { randomUUID } from 'node:crypto'
import { StoreError } from './errors.ts'
import { nextRating, PLACEMENT_GAMES, START_RATING, tierOf } from './elo.ts'
import type { OpenPackResult, PacksResult, Player, PlayerStore, RankedResult, WalletResult } from './types.ts'

const LEADERBOARD_PAGE_SIZE = 50
type StoredRating = { rating: number; games: number }
type TransactionResults = {
  credit: WalletResult
  debit: WalletResult
  addPacks: PacksResult
  openPack: OpenPackResult
}
type Transaction = {
  op: keyof TransactionResults
  player: string
  params: string
  result: TransactionResults[keyof TransactionResults]
}

function stringArgument(value: unknown, name: string, max = Infinity): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new StoreError('bad_argument', `Invalid ${name}`)
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StoreError('bad_argument', `Invalid ${name}`)
  }
}

function copyPlayer(player: Player): Player {
  return { ...player, identities: player.identities.map(identity => ({ ...identity })) }
}

export function createMemoryStore(opts: { now?: () => number; uuid?: () => string } = {}): PlayerStore {
  const now = opts.now ?? Date.now
  const uuid = opts.uuid ?? randomUUID
  const players = new Map<string, Player>()
  const identities = new Map<string, string>()
  const ratings = new Map<string, StoredRating>()
  const rankedResults = new Map<string, RankedResult>()
  const wallets = new Map<string, number>()
  const packs = new Map<string, number>()
  const collections = new Map<string, Record<string, number>>()
  const transactions = new Map<string, Transaction>()
  const key = (player: string, game: string) => `${player}\u0000${game}`

  function requirePlayer(playerId: string): Player {
    stringArgument(playerId, 'player id')
    const player = players.get(playerId)
    if (!player) throw new StoreError('not_found', 'Player not found')
    return player
  }

  function ratingFor(playerId: string, game: string): StoredRating {
    return ratings.get(key(playerId, game)) ?? { rating: START_RATING, games: 0 }
  }

  function repeat<T extends keyof TransactionResults>(
    op: T, player: string, params: string, txId: string,
  ): TransactionResults[T] | undefined {
    const tx = transactions.get(txId)
    if (!tx) return undefined
    if (tx.op !== op || tx.player !== player || tx.params !== params) {
      throw new StoreError('tx_conflict', 'Transaction id already used with different parameters')
    }
    return { ...structuredClone(tx.result), applied: false } as TransactionResults[T]
  }

  function changeWallet(op: 'credit' | 'debit', playerId: string, amount: number, reason: string, txId: string): WalletResult {
    positiveInteger(amount, 'amount')
    stringArgument(reason, 'reason', 64)
    stringArgument(txId, 'transaction id', 128)
    requirePlayer(playerId)
    const params = JSON.stringify([amount, reason])
    const previous = repeat(op, playerId, params, txId)
    if (previous) return previous
    const balance = wallets.get(playerId) ?? 0
    if (op === 'debit' && amount > balance) {
      throw new StoreError('insufficient_funds', 'Insufficient funds')
    }
    const result = { balance: balance + (op === 'credit' ? amount : -amount), applied: true }
    wallets.set(playerId, result.balance)
    transactions.set(txId, { op, player: playerId, params, result })
    return { ...result }
  }

  return {
    async getOrCreateByIdentity(identity, init) {
      if (!identity || !['wavedash', 'itch', 'guest'].includes(identity.provider)) {
        throw new StoreError('bad_argument', 'Invalid identity provider')
      }
      stringArgument(identity.external_id, 'external id', 256)
      const identityKey = `${identity.provider}\u0000${identity.external_id}`
      const existing = identities.get(identityKey)
      if (existing !== undefined) return { player: copyPlayer(players.get(existing)!), created: false }
      const kind = init?.kind ?? 'human'
      if (kind !== 'human' && kind !== 'resident') throw new StoreError('bad_argument', 'Invalid player kind')
      const playerId = uuid()
      const name = typeof init?.display_name === 'string' ? init.display_name.trim() : ''
      const player: Player = {
        player_id: playerId,
        display_name: name.length >= 3 && name.length <= 16 ? name : `Player-${playerId.slice(0, 4)}`,
        kind,
        identities: [{ provider: identity.provider, external_id: identity.external_id }],
        active_ranked_match: null,
        created_at: now(),
      }
      players.set(playerId, player)
      identities.set(identityKey, playerId)
      return { player: copyPlayer(player), created: true }
    },

    async getPlayer(playerId) {
      stringArgument(playerId, 'player id')
      const player = players.get(playerId)
      return player ? copyPlayer(player) : null
    },

    async getRating(playerId, game) {
      requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      const rating = ratingFor(playerId, game)
      return { game, ...rating, placement: rating.games < PLACEMENT_GAMES }
    },

    async applyRankedResult(outcome) {
      if (!outcome) throw new StoreError('bad_argument', 'Invalid ranked outcome')
      const { match_id, game, a, b, score_a } = outcome
      stringArgument(match_id, 'match id')
      stringArgument(game, 'game', 64)
      stringArgument(a, 'player a')
      stringArgument(b, 'player b')
      if (a === b || (score_a !== 0 && score_a !== 0.5 && score_a !== 1)) {
        throw new StoreError('bad_argument', 'Invalid ranked players or score')
      }
      const previous = rankedResults.get(match_id)
      if (previous) return { ...structuredClone(previous), applied: false }
      const playerA = requirePlayer(a)
      const playerB = requirePlayer(b)
      const beforeA = ratingFor(a, game)
      const beforeB = ratingFor(b, game)
      const afterA = {
        rating: nextRating(beforeA.rating, beforeB.rating, score_a, beforeA.games),
        games: beforeA.games + 1,
      }
      const afterB = {
        rating: nextRating(beforeB.rating, beforeA.rating, (1 - score_a) as 0 | 0.5 | 1, beforeB.games),
        games: beforeB.games + 1,
      }
      const result: RankedResult = {
        match_id, game, applied: true,
        a: { player_id: a, before: beforeA.rating, after: afterA.rating, games: afterA.games, placement: afterA.games < PLACEMENT_GAMES },
        b: { player_id: b, before: beforeB.rating, after: afterB.rating, games: afterB.games, placement: afterB.games < PLACEMENT_GAMES },
      }
      ratings.set(key(a, game), afterA)
      ratings.set(key(b, game), afterB)
      if (playerA.active_ranked_match === match_id) playerA.active_ranked_match = null
      if (playerB.active_ranked_match === match_id) playerB.active_ranked_match = null
      rankedResults.set(match_id, result)
      return structuredClone(result)
    },

    async lockRanked(playerId, matchId) {
      stringArgument(playerId, 'player id')
      stringArgument(matchId, 'match id')
      const player = players.get(playerId)
      if (!player || (player.active_ranked_match !== null && player.active_ranked_match !== matchId)) return false
      player.active_ranked_match = matchId
      return true
    },

    async unlockRanked(playerId, matchId) {
      stringArgument(playerId, 'player id')
      stringArgument(matchId, 'match id')
      const player = players.get(playerId)
      if (!player || player.active_ranked_match !== matchId) return false
      player.active_ranked_match = null
      return true
    },

    async balance(playerId) {
      requirePlayer(playerId)
      return wallets.get(playerId) ?? 0
    },

    async credit(playerId, amount, reason, txId) {
      return changeWallet('credit', playerId, amount, reason, txId)
    },

    async debit(playerId, amount, reason, txId) {
      return changeWallet('debit', playerId, amount, reason, txId)
    },

    async unopenedPacks(playerId, game) {
      requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      return packs.get(key(playerId, game)) ?? 0
    },

    async addPacks(playerId, game, count, reason, txId) {
      requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      positiveInteger(count, 'pack count')
      stringArgument(reason, 'reason', 64)
      stringArgument(txId, 'transaction id', 128)
      const params = JSON.stringify([game, count, reason])
      const previous = repeat('addPacks', playerId, params, txId)
      if (previous) return previous
      const packKey = key(playerId, game)
      const result = { unopened: (packs.get(packKey) ?? 0) + count, applied: true }
      packs.set(packKey, result.unopened)
      transactions.set(txId, { op: 'addPacks', player: playerId, params, result })
      return { ...result }
    },

    async openPack(playerId, game, roller, txId) {
      requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      stringArgument(txId, 'transaction id', 128)
      const params = JSON.stringify([game])
      const previous = repeat('openPack', playerId, params, txId)
      if (previous) return previous
      if (typeof roller !== 'function') throw new StoreError('bad_argument', 'Invalid pack roller')
      const packKey = key(playerId, game)
      if ((packs.get(packKey) ?? 0) === 0) throw new StoreError('no_packs', 'No unopened packs')

      const rolled = await roller(playerId, game)

      // Other opens or economy operations may have committed while the roller ran.
      const concurrent = repeat('openPack', playerId, params, txId)
      if (concurrent) return concurrent
      const unopened = packs.get(packKey) ?? 0
      if (unopened === 0) throw new StoreError('no_packs', 'No unopened packs')
      if (!Array.isArray(rolled) || rolled.length < 1 || rolled.length > 64) {
        throw new StoreError('bad_argument', 'A pack must contain 1..64 cards')
      }
      const cards = [...rolled]
      for (const card of cards) stringArgument(card, 'card id')
      const collection: Record<string, number> = Object.assign(Object.create(null), collections.get(packKey))
      for (const card of cards) collection[card] = (collection[card] ?? 0) + 1
      const result = { cards, remaining: unopened - 1, applied: true }
      packs.set(packKey, result.remaining)
      collections.set(packKey, collection)
      transactions.set(txId, { op: 'openPack', player: playerId, params, result })
      return structuredClone(result)
    },

    async collection(playerId, game) {
      requirePlayer(playerId)
      stringArgument(game, 'game', 64)
      return { ...collections.get(key(playerId, game)) }
    },

    async leaderboard(game, page) {
      stringArgument(game, 'game', 64)
      positiveInteger(page, 'page')
      const entries = []
      for (const player of players.values()) {
        const rating = ratings.get(key(player.player_id, game))
        if (!rating || rating.games < PLACEMENT_GAMES) continue
        entries.push({
          player_id: player.player_id, display_name: player.display_name,
          ...rating, tier: tierOf(rating.rating),
        })
      }
      entries.sort((a, b) => b.rating - a.rating || (a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0))
      const start = (page - 1) * LEADERBOARD_PAGE_SIZE
      return {
        game, page, page_size: LEADERBOARD_PAGE_SIZE, total: entries.length,
        entries: entries.slice(start, start + LEADERBOARD_PAGE_SIZE).map((entry, i) => ({ rank: start + i + 1, ...entry })),
      }
    },
  }
}
