// Economy state of the players (coins, closed packs, cards) over the tenant tables.
//
// The generic table API has no transaction, so atomicity comes from ONE append-only fact per operation:
//   * etc_ledger (unique tx_id) is the journal AND the idempotency guard. An operation is decided (validated, cards
//     drawn, deltas computed) and then committed by inserting its ledger row; a replay finds the row and returns
//     the stored result (`applied: false`), a replay with other parameters fails `tx_conflict`.
//   * etc_wallets / etc_packs / etc_cards are the PROJECTION of the journal. Every row remembers the id of the last
//     ledger row it applied (`last_ledger_id` / `ledger_id`), so applying a ledger row is idempotent. Every
//     operation first applies the player's not-yet-applied ledger rows (catch-up): a crash between the commit
//     and the projection is repaired by the next operation or read of that player.
// A per-player in-process mutex serialises the steps of one Handshake instance.

import { StoreError } from '../store/errors.ts'
import type { Filter, Row, TableApi } from '../store/tables.ts'
import { createKeyedLock } from './lock.ts'
import { findReward } from './catalog.ts'
import { cryptoRng, drawRandom, fixedCards } from './draw.ts'
import type { Rng } from './draw.ts'
import type { BuyResult, Catalog, DrawnCard, EconomyState, Fx, OpenResult, OpResult, Product, RewardResult } from './types.ts'

export const ECO_OPS = ['eco.reward', 'eco.buy', 'eco.open', 'eco.grant', 'eco.reverse'] as const
const PAGE = 500
const CATCHUP_PAGE = 50
const T = { wallets: 'etc_wallets', packs: 'etc_packs', cards: 'etc_cards', ledger: 'etc_ledger' }

export interface EconomyLedger {
  state(playerId: string): Promise<EconomyState>
  reward(playerId: string, rewardId: string): Promise<OpResult<RewardResult>>
  buyWithCoins(playerId: string, opId: string, product: Product, qty: number): Promise<OpResult<BuyResult>>
  openPack(playerId: string, opId: string, packType: string): Promise<OpResult<OpenResult>>
  /** Credits what a paid product contains. `txId` is the idempotency key (e.g. `wd:<purchaseId>`). */
  grantProduct(playerId: string, txId: string, product: Product): Promise<OpResult<{ coins: number; packs: Record<string, number> }>>
  /** Claws back what `originalTxId` (a refunded purchase) gave: its coins, then its closed packs; whatever was already
   *  spent is recovered from the player's later pack purchases (closed packs first, then the cards drawn from the newest
   *  openings). Never goes below zero; cards are removed whole copies at a time. */
  reverse(playerId: string, txId: string, originalTxId: string): Promise<OpResult<{ coins: number; packs: Record<string, number>; cards: Record<string, number> }>>
  /** The ledger fx of an earlier operation, or null. */
  grantedBy(txId: string): Promise<Fx | null>
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function arg(value: unknown, name: string, max = 128): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new StoreError('bad_argument', `Invalid ${name}`)
}

const emptyFx = (): Fx => ({ coins: 0, packs: {}, cards: {} })

export function createEconomyLedger(api: TableApi, opts: {
  catalog: () => Catalog
  now?: () => number
  rng?: Rng
}): EconomyLedger {
  const now = opts.now ?? Date.now
  const rng = opts.rng ?? cryptoRng
  const locked = createKeyedLock()

  async function all(table: string, filters: Filter[]): Promise<Row[]> {
    const out: Row[] = []
    for (let page = 1; ; page++) {
      const rows = await api.query(table, { filters, page, size: PAGE })
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }
  const one = async (table: string, filters: Filter[]) => (await api.query(table, { filters, size: 1 }))[0]
  const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })

  async function ensureWallet(playerId: string): Promise<Row> {
    const found = await one(T.wallets, [eq('player_id', playerId)])
    if (found) return found
    const made = await api.insert(T.wallets, { player_id: playerId, coins: 0, version: 0, last_ledger_id: 0, updated_at: now() })
    if (made !== 'conflict') return made.row
    const raced = await one(T.wallets, [eq('player_id', playerId)])
    if (!raced) throw new Error('wallet creation failed')
    return raced
  }

  /** Applies +delta to a (player, key) row once per ledger id. */
  async function bump(table: string, keys: Record<string, string>, delta: number, ledgerId: number, extra: Row): Promise<void> {
    if (delta === 0) return
    const filters = Object.entries(keys).map(([k, v]) => eq(k, v))
    let row = await one(table, filters)
    if (!row) {
      const made = await api.insert(table, { ...keys, quantity: Math.max(0, delta), ledger_id: ledgerId, updated_at: now(), ...extra })
      if (made !== 'conflict') return
      row = await one(table, filters)
      if (!row) throw new Error(`${table} row vanished`)
    }
    if (num(row.ledger_id) >= ledgerId) return
    await api.update(table, row.id as number, { quantity: Math.max(0, num(row.quantity) + delta), ledger_id: ledgerId, updated_at: now() })
  }

  function fxOf(row: Row): Fx {
    try {
      const parsed = JSON.parse(row.result_json as string) as { fx?: Partial<Fx> }
      return { coins: num(parsed.fx?.coins), packs: parsed.fx?.packs ?? {}, cards: parsed.fx?.cards ?? {} }
    } catch {
      return emptyFx()
    }
  }

  /** Applies one committed ledger row to the projection. The wallet is written LAST: it is the commit marker of the catch-up. */
  async function applyRow(playerId: string, wallet: Row, ledgerRow: Row): Promise<Row> {
    const id = num(ledgerRow.id)
    const fx = fxOf(ledgerRow)
    for (const [type, d] of Object.entries(fx.packs)) await bump(T.packs, { player_id: playerId, pack_type: type }, d, id, {})
    for (const [card, d] of Object.entries(fx.cards)) await bump(T.cards, { player_id: playerId, card_id: card }, d, id, { first_at: now() })
    const patch = { coins: num(wallet.coins) + fx.coins, version: num(wallet.version) + 1, last_ledger_id: id, updated_at: now() }
    await api.update(T.wallets, wallet.id as number, patch)
    return { ...wallet, ...patch }
  }

  async function catchUp(playerId: string, wallet: Row): Promise<Row> {
    const last = num(wallet.last_ledger_id)
    const pending: Row[] = []
    for (let page = 1; ; page++) {
      const rows = await api.query(T.ledger, {
        filters: [eq('player_id', playerId), { field: 'op', op: 'in', values: [...ECO_OPS] }],
        sort: [{ field: 'id', dir: 'desc' }], page, size: CATCHUP_PAGE,
      })
      let reached = false
      for (const r of rows) {
        if (num(r.id) <= last) { reached = true; break }
        pending.push(r)
      }
      if (reached || rows.length < CATCHUP_PAGE) break
    }
    pending.sort((a, b) => num(a.id) - num(b.id))
    let w = wallet
    for (const r of pending) w = await applyRow(playerId, w, r)
    return w
  }

  async function loadState(playerId: string, wallet: Row): Promise<EconomyState> {
    const packs: Record<string, number> = {}
    for (const r of await all(T.packs, [eq('player_id', playerId)])) if (num(r.quantity) > 0) packs[r.pack_type as string] = num(r.quantity)
    const cards: Record<string, number> = {}
    for (const r of await all(T.cards, [eq('player_id', playerId)])) if (num(r.quantity) > 0) cards[r.card_id as string] = num(r.quantity)
    return { coins: num(wallet.coins), version: num(wallet.version), packs, cards }
  }

  interface Built<R> { fx: Fx; result: R }

  /** The one write path: lock, catch up, replay-or-decide, commit the ledger row, project it. */
  async function run<R extends object>(
    playerId: string, txId: string, op: (typeof ECO_OPS)[number], params: unknown,
    build: (state: EconomyState) => Built<R> | Promise<Built<R>>,
  ): Promise<OpResult<R>> {
    arg(playerId, 'player id'); arg(txId, 'transaction id', 200)
    const paramText = JSON.stringify(params)
    return locked([`p:${playerId}`], async () => {
      let wallet = await catchUp(playerId, await ensureWallet(playerId))
      const replay = async (): Promise<OpResult<R> | undefined> => {
        const row = await one(T.ledger, [eq('tx_id', txId)])
        if (!row) return undefined
        if (row.op !== op || row.player_id !== playerId || row.params !== paramText) {
          throw new StoreError('tx_conflict', 'Transaction id already used with different parameters')
        }
        // The row may be committed but not projected (crash, or a racing instance): project it before answering.
        wallet = await catchUp(playerId, wallet)
        return { result: (JSON.parse(row.result_json as string) as { result: R }).result, applied: false }
      }
      const before = await replay()
      if (before) return before
      const state = await loadState(playerId, wallet)
      const { fx, result } = await build(state)
      const packDelta = Object.values(fx.packs).reduce((a, b) => a + b, 0)
      const committed = await api.insert(T.ledger, {
        tx_id: txId, player_id: playerId, op, game: '', coin_delta: fx.coins, pack_delta: packDelta, created_at: now(),
        params: paramText, result_json: JSON.stringify({ result, fx }),
      })
      if (committed === 'conflict') {
        const raced = await replay()
        if (raced) return raced
        throw new StoreError('tx_conflict', 'Transaction id already used')
      }
      wallet = await catchUp(playerId, wallet)
      return { result, applied: true }
    })
  }

  const plus = (a: Record<string, number>, b: Record<string, number>, k = 1): Record<string, number> => {
    const out = { ...a }
    for (const [t, n] of Object.entries(b)) out[t] = (out[t] ?? 0) + n * k
    return out
  }

  return {
    async state(playerId) {
      arg(playerId, 'player id')
      return locked([`p:${playerId}`], async () => loadState(playerId, await catchUp(playerId, await ensureWallet(playerId))))
    },

    async reward(playerId, rewardId) {
      arg(rewardId, 'reward id', 96)
      const def = findReward(opts.catalog(), rewardId)
      if (!def) throw new StoreError('unknown_reward', 'Unknown reward')
      // One grant per player and reward id, whatever the client op id: claiming it again changes nothing.
      return run(playerId, `rw:${playerId}:${rewardId}`, 'eco.reward', [rewardId], state => ({
        fx: { coins: def.coins, packs: { ...def.packs }, cards: {} },
        result: { reward_id: rewardId, granted: def, coins: state.coins + def.coins },
      }))
    },

    async buyWithCoins(playerId, opId, product, qty) {
      arg(opId, 'operation id', 64)
      if (product.provider !== 'coins') throw new StoreError('unknown_product', 'Not a coin product')
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100) throw new StoreError('bad_argument', 'Invalid quantity')
      return run(playerId, `c:${playerId}:${opId}`, 'eco.buy', [product.code, qty], state => {
        const cost = product.price * qty
        if (cost > state.coins) throw new StoreError('insufficient_funds', 'Insufficient funds')
        const packs = plus({}, product.grant_packs, qty)
        const coinsBack = product.grant_coins * qty
        return {
          fx: { coins: coinsBack - cost, packs, cards: {} },
          result: { product: product.code, qty, coins: state.coins + coinsBack - cost, packs },
        }
      })
    },

    async openPack(playerId, opId, packType) {
      arg(opId, 'operation id', 64); arg(packType, 'pack type', 64)
      const catalog = opts.catalog()
      const def = catalog.packs[packType]
      if (!def) throw new StoreError('unknown_pack', 'Unknown pack type')
      return run(playerId, `c:${playerId}:${opId}`, 'eco.open', [packType], state => {
        if ((state.packs[packType] ?? 0) < 1) throw new StoreError('no_packs', 'No unopened pack of this type')
        const owned = new Set(Object.keys(state.cards))
        const pool = catalog.cards.filter(c => c.token !== true)
        const cards: DrawnCard[] = def.kind === 'fixed'
          ? fixedCards(def, new Map(catalog.cards.map(c => [c.id, c])), owned)
          : drawRandom(def, rng, pool, owned)
        if (cards.length === 0) throw new StoreError('unknown_pack', 'The pack cannot be drawn (empty card pool)')
        const dups = cards.filter(c => c.duplicate).length
        const refund = def.duplicate_refund * dups
        const gained: Record<string, number> = {}
        for (const c of cards) gained[c.id] = (gained[c.id] ?? 0) + 1
        return {
          fx: { coins: refund, packs: { [packType]: -1 }, cards: gained },
          result: { pack_type: packType, cards, refund, coins: state.coins + refund, remaining: (state.packs[packType] ?? 0) - 1 },
        }
      })
    },

    async grantProduct(playerId, txId, product) {
      return run(playerId, txId, 'eco.grant', [product.provider, product.code], () => ({
        fx: { coins: product.grant_coins, packs: { ...product.grant_packs }, cards: {} },
        result: { coins: product.grant_coins, packs: { ...product.grant_packs } },
      }))
    },

    async reverse(playerId, txId, originalTxId) {
      arg(originalTxId, 'original transaction id', 200)
      return run(playerId, txId, 'eco.reverse', [originalTxId], async state => {
        const original = await one(T.ledger, [eq('tx_id', originalTxId)])
        const mine = original && original.player_id === playerId
        const fx = mine ? fxOf(original) : emptyFx()
        const origId = mine ? num(original.id) : 0
        const left = { ...state.packs }
        const cardsLeft = { ...state.cards }
        const packs: Record<string, number> = {}
        const cards: Record<string, number> = {}
        const owedOpened: Record<string, number> = {}   // packs that must be recovered from what was opened
        const takePacks = (type: string, n: number): number => {
          const take = Math.min(n, left[type] ?? 0)
          if (take > 0) { packs[type] = (packs[type] ?? 0) - take; left[type] = (left[type] ?? 0) - take }
          return take
        }

        // 1. the coins of the purchase, as far as they are still there
        const coins = Math.min(Math.max(0, fx.coins), state.coins)
        let shortfall = Math.max(0, fx.coins) - coins   // coins already spent

        // 2. the packs of the purchase: closed ones are taken, opened ones are owed
        for (const [t, n] of Object.entries(fx.packs)) {
          const taken = takePacks(t, n)
          if (n - taken > 0) owedOpened[t] = (owedOpened[t] ?? 0) + (n - taken)
        }

        if (origId > 0 && (shortfall > 0 || Object.keys(owedOpened).length > 0)) {
          const after = (op: string) => all(T.ledger, [eq('player_id', playerId), eq('op', op), { field: 'id', op: 'gt', value: origId }])
          const newest = (rows: Row[]) => rows.sort((a, b) => num(b.id) - num(a.id))

          // 3. coins already spent: undo the player's later pack purchases, newest first
          if (shortfall > 0) {
            for (const row of newest(await after('eco.buy'))) {
              if (shortfall <= 0) break
              const bfx = fxOf(row)
              const total = Object.values(bfx.packs).reduce((a, b) => a + Math.max(0, b), 0)
              const spent = -num(row.coin_delta)
              if (total <= 0 || spent <= 0) continue
              const perPack = spent / total
              for (const [t, k] of Object.entries(bfx.packs)) {
                if (shortfall <= 0 || k <= 0) continue
                const want = Math.min(k, Math.ceil(shortfall / perPack))
                const taken = takePacks(t, want)
                if (want - taken > 0) owedOpened[t] = (owedOpened[t] ?? 0) + (want - taken)
                shortfall -= want * perPack
              }
            }
          }

          // 4. packs that were opened: remove the cards of the newest openings of that type
          if (Object.keys(owedOpened).length > 0) {
            const opens = newest(await after('eco.open'))
            for (const [t, n0] of Object.entries(owedOpened)) {
              let n = n0
              for (const row of opens) {
                if (n <= 0) break
                let type: unknown
                try { type = (JSON.parse(row.params as string) as unknown[])[0] } catch { type = undefined }
                if (type !== t) continue
                n--
                for (const [card, c] of Object.entries(fxOf(row).cards)) {
                  const rm = Math.min(Math.max(0, c), cardsLeft[card] ?? 0)
                  if (rm > 0) { cards[card] = (cards[card] ?? 0) - rm; cardsLeft[card] = (cardsLeft[card] ?? 0) - rm }
                }
              }
            }
          }
        }
        return { fx: { coins: -coins, packs, cards }, result: { coins: -coins, packs, cards } }
      })
    },

    async grantedBy(txId) {
      const row = await one(T.ledger, [eq('tx_id', txId)])
      return row ? fxOf(row) : null
    },
  }
}
