// One EconomyService per game (= per mission): the state of the players, the coin shop, pack opening, rewards,
// and the paid purchases (Wavedash consumables, Stripe Checkout). All durable state is in the mission's tables;
// the service keeps no balance of its own.

import { StoreError } from '../store/errors.ts'
import type { Filter, Row, TableApi } from '../store/tables.ts'
import type { PlayerStore } from '../store/types.ts'
import { createKeyedLock } from './lock.ts'
import { createCatalog, parseProduct } from './catalog.ts'
import type { CatalogHandle } from './catalog.ts'
import { createEconomyLedger } from './ledger.ts'
import type { EconomyLedger } from './ledger.ts'
import type { Rng } from './draw.ts'
import { WavedashError } from './wavedash.ts'
import type { ReceiptClaims, Wavedash } from './wavedash.ts'
import type { StripeBridge } from './stripe.ts'
import type { BuyResult, OpenResult, OpResult, Product, ProductProvider, PurchaseResult, RewardResult } from './types.ts'

export interface EconomyView {
  coins: number
  version: number
  packs: Array<{ pack_type: string; quantity: number }>
  cards: Record<string, number>
}

export interface ProductView {
  provider: ProductProvider
  code: string
  label: string
  description: string
  price: number
  currency: string
  grant_coins: number
  grant_packs: Record<string, number>
}

export class EconomyUnavailable extends Error {
  constructor(what: string) {
    super(`economy: ${what} is not configured`)
    this.name = 'EconomyUnavailable'
  }
}

export interface EconomyService {
  readonly game: string
  readonly catalog: CatalogHandle
  state(playerId: string): Promise<EconomyView>
  products(): Promise<ProductView[]>
  reward(playerId: string, rewardId: string): Promise<OpResult<RewardResult>>
  buy(playerId: string, opId: string, productCode: string, qty: number): Promise<OpResult<BuyResult>>
  open(playerId: string, opId: string, packType: string): Promise<OpResult<OpenResult>>
  /** A receipt forwarded by the game client of an authenticated player (optionally with the user JWT). */
  wavedashFromClient(playerId: string, receiptJwt: string, userJwt: string | undefined): Promise<PurchaseResult & { applied: boolean }>
  /** A receipt delivered by the Wavedash webhook (no session): the buyer is the player of the receipt's `sub`. Fulfills after granting. */
  wavedashFromWebhook(receiptJwt: string): Promise<PurchaseResult & { applied: boolean }>
  wavedashGameIds(): Promise<string[]>
  stripeCheckout(playerId: string, productCode: string, returnUrl: string): Promise<{ url: string; session_id: string }>
  /** A signature-verified Stripe event whose session belongs to this game. */
  stripeCompleted(session: Record<string, unknown>): Promise<(PurchaseResult & { applied: boolean }) | { status: 'ignored'; reason: string }>
  /** Reverses the purchase of this payment intent, if this game has it. false = not found here. */
  stripeRefunded(paymentIntent: string): Promise<boolean>
  hasStripe(): boolean
  /** Signature check of a raw Stripe webhook through the bridge: the event, or null when the signature is invalid. */
  stripeVerify(rawBody: string, signature: string): Promise<Record<string, unknown> | null>
  onChange(fn: (playerId: string) => void): void
  start(): void
  stop(): void
}

export interface EconomyServiceDeps {
  game: string
  api: TableApi
  store: PlayerStore
  wavedash?: Wavedash
  stripe?: StripeBridge | null
  now?: () => number
  rng?: Rng
  log?: (level: string, msg: string) => void
  catalogIntervalMs?: number
}

const CACHE_MS = 30_000
const SETTING_ALLOW_PLAYTEST = 'economy.allow_playtest'

export function createEconomyService(deps: EconomyServiceDeps): EconomyService {
  const { api, game } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const catalog = createCatalog(api, { game, intervalMs: deps.catalogIntervalMs, log })
  const ledger: EconomyLedger = createEconomyLedger(api, { catalog: catalog.current, now, rng: deps.rng })
  const locked = createKeyedLock()
  const listeners: Array<(playerId: string) => void> = []
  const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })
  const one = async (table: string, filters: Filter[]): Promise<Row | undefined> => (await api.query(table, { filters, size: 1 }))[0]
  const notify = (playerId: string): void => { for (const fn of listeners) { try { fn(playerId) } catch { /* a listener never breaks a grant */ } } }

  const cache = new Map<string, { at: number; value: unknown }>()
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && now() - hit.at < CACHE_MS) return hit.value as T
    const value = await load()
    cache.set(key, { at: now(), value })
    return value
  }

  async function findProduct(provider: ProductProvider, code: string, activeOnly = true): Promise<Product | null> {
    const row = await one('etc_products', [eq('provider', provider), eq('code', code)])
    const p = row ? parseProduct(row) : null
    return p && (!activeOnly || p.active) ? p : null
  }

  async function wavedashGameIds(): Promise<string[]> {
    return cached('wd-ids', async () => {
      const rows = await api.query('etc_publishers', { filters: [eq('platform', 'wavedash')], size: 50 })
      return rows.filter(r => r.enabled !== false && typeof r.external_id === 'string' && r.external_id !== '').map(r => r.external_id as string)
    })
  }
  async function allowPlaytest(): Promise<boolean> {
    return cached('allow-playtest', async () => {
      const row = await one('etc_settings', [eq('key', SETTING_ALLOW_PLAYTEST)])
      return row?.value === '1' || row?.value === 'true'
    })
  }

  // --- purchases ---------------------------------------------------------------------------------------------

  const purchase = (provider: string, externalId: string) => one('etc_purchases', [eq('provider', provider), eq('external_id', externalId)])

  async function openPurchase(provider: ProductProvider, externalId: string, row: Row): Promise<Row> {
    const made = await api.insert('etc_purchases', { provider, external_id: externalId, status: 'pending', created_at: now(), ...row })
    if (made !== 'conflict') return made.row
    const existing = await purchase(provider, externalId)
    if (!existing) throw new Error('purchase row vanished')
    return existing
  }

  async function markGranted(row: Row, extra: Row = {}): Promise<void> {
    if (row.status === 'granted' && Object.keys(extra).length === 0) return
    await api.update('etc_purchases', row.id as number, { status: 'granted', granted_at: row.granted_at ?? now(), ...extra })
  }

  /** The grant of a purchase: idempotent through the ledger, then the purchase row. */
  async function grant(provider: ProductProvider, externalId: string, playerId: string, product: Product, extra: Row, txId: string): Promise<PurchaseResult & { applied: boolean }> {
    return locked([`x:${provider}:${externalId}`], async () => {
      let row = await openPurchase(provider, externalId, { player_id: playerId, product_code: product.code, amount: product.price, currency: product.currency, ...extra })
      if (row.status === 'refunded') throw new StoreError('purchase_refunded', 'This purchase was refunded')
      if (row.player_id !== playerId) throw new StoreError('bad_argument', 'This purchase belongs to another player')
      const r = await ledger.grantProduct(playerId, txId, product)
      await markGranted(row, extra.payment_ref ? { payment_ref: extra.payment_ref } : {})
      row = { ...row, status: 'granted' }
      if (r.applied) notify(playerId)
      return {
        provider, external_id: externalId, product: product.code, status: 'granted', coins: (await ledger.state(playerId)).coins,
        granted: r.result, applied: r.applied,
      }
    })
  }

  /** Marks a purchase refunded and takes back what the ledger granted for it. A refund seen first blocks a later grant. */
  async function refund(provider: ProductProvider, externalId: string, txId: string, fallback?: { player_id: string; product_code: string }): Promise<void> {
    await locked([`x:${provider}:${externalId}`], async () => {
      const row = await purchase(provider, externalId)
      if (!row) {
        if (!fallback) return
        await api.insert('etc_purchases', { provider, external_id: externalId, player_id: fallback.player_id, product_code: fallback.product_code, status: 'refunded', created_at: now(), refunded_at: now() })
        return
      }
      if (row.status === 'refunded') return
      const playerId = row.player_id as string
      if (await ledger.grantedBy(txId)) {
        await ledger.reverse(playerId, `rf:${provider}:${externalId}`, txId)
        notify(playerId)
      }
      await api.update('etc_purchases', row.id as number, { status: 'refunded', refunded_at: now() })
    })
  }

  function result(r: PurchaseResult & { applied: boolean }) { return r }

  // --- Wavedash ------------------------------------------------------------------------------------------------

  async function wavedashReceipt(receiptJwt: string): Promise<ReceiptClaims> {
    if (!deps.wavedash) throw new EconomyUnavailable('wavedash')
    return deps.wavedash.verifyReceipt(receiptJwt, { gameIds: await wavedashGameIds(), allowPlaytest: await allowPlaytest() })
  }

  async function applyReceipt(claims: ReceiptClaims, playerId: string): Promise<PurchaseResult & { applied: boolean }> {
    const txId = `wd:${claims.purchaseId}`
    if (claims.event === 'purchase.refunded') {
      await refund('wavedash', claims.purchaseId, txId, { player_id: playerId, product_code: claims.contentIdentifier })
      return result({ provider: 'wavedash', external_id: claims.purchaseId, product: claims.contentIdentifier, status: 'refunded', coins: (await ledger.state(playerId)).coins, granted: { coins: 0, packs: {} }, applied: true })
    }
    const product = await findProduct('wavedash', claims.contentIdentifier)
    if (!product) throw new StoreError('unknown_product', 'Unknown product')
    return grant('wavedash', claims.purchaseId, playerId, product, { payload: JSON.stringify({ gcid: claims.gcid, env: claims.env }) }, txId)
  }

  // --- the service ---------------------------------------------------------------------------------------------

  return {
    game,
    catalog,

    async state(playerId) {
      const s = await ledger.state(playerId)
      return { coins: s.coins, version: s.version, packs: Object.entries(s.packs).map(([pack_type, quantity]) => ({ pack_type, quantity })), cards: s.cards }
    },

    async products() {
      const rows = await api.query('etc_products', { filters: [eq('active', true)], sort: [{ field: 'sort_order', dir: 'asc' }, { field: 'id', dir: 'asc' }], size: 200 })
      const out: ProductView[] = []
      for (const r of rows) {
        const p = parseProduct(r)
        if (p && p.active) out.push({ provider: p.provider, code: p.code, label: p.label, description: typeof r.description === 'string' ? r.description : '', price: p.price, currency: p.currency, grant_coins: p.grant_coins, grant_packs: p.grant_packs })
      }
      return out
    },

    reward: (playerId, rewardId) => ledger.reward(playerId, rewardId),

    async buy(playerId, opId, productCode, qty) {
      const product = await findProduct('coins', productCode)
      if (!product) throw new StoreError('unknown_product', 'Unknown product')
      const r = await ledger.buyWithCoins(playerId, opId, product, qty)
      // The shop receipt: one purchases row per coin purchase (insert-or-ignore: a replay adds nothing).
      await openPurchase('coins', `c:${playerId}:${opId}`, {
        player_id: playerId, product_code: product.code, status: 'granted', amount: product.price * qty, currency: 'coins', granted_at: now(),
      }).catch(() => undefined)
      return r
    },

    open: (playerId, opId, packType) => ledger.openPack(playerId, opId, packType),

    async wavedashFromClient(playerId, receiptJwt, userJwt) {
      const claims = await wavedashReceipt(receiptJwt)
      if (userJwt !== undefined) {
        const user = await deps.wavedash!.verifyUser(userJwt)
        if (user.sub !== claims.sub || (user.gcid !== null && claims.gcid !== null && user.gcid !== claims.gcid)) throw new WavedashError('receipt_mismatch', 'user jwt')
      }
      const player = await deps.store.getPlayer(playerId)
      if (!player || !player.identities.some(i => i.provider === 'wavedash' && i.external_id === claims.sub)) throw new WavedashError('receipt_mismatch', 'buyer')
      return applyReceipt(claims, playerId)
    },

    async wavedashFromWebhook(receiptJwt) {
      const claims = await wavedashReceipt(receiptJwt)
      const { player } = await deps.store.getOrCreateByIdentity({ provider: 'wavedash', external_id: claims.sub })
      const res = await applyReceipt(claims, player.player_id)
      if (claims.event === 'purchase.completed') {
        const status = await deps.wavedash!.fulfill(claims.purchaseId, receiptJwt)
        if (status === 'NOT_FOUND') log('error', `[economy] ${game}: wavedash fulfill NOT_FOUND for ${claims.purchaseId} (refunded meanwhile?)`)
      }
      return res
    },

    wavedashGameIds,

    async stripeCheckout(playerId, productCode, returnUrl) {
      if (!deps.stripe) throw new EconomyUnavailable('stripe')
      const product = await findProduct('stripe', productCode)
      if (!product) throw new StoreError('unknown_product', 'Unknown product')
      const sep = returnUrl.includes('?') ? '&' : '?'
      const s = await deps.stripe.checkout({
        product_code: product.code, player_id: playerId, game,
        success_url: `${returnUrl}${sep}checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnUrl}${sep}checkout=cancel`,
      })
      await openPurchase('stripe', s.session_id, { player_id: playerId, product_code: product.code, amount: product.price, currency: product.currency })
      return s
    },

    async stripeCompleted(session) {
      const id = typeof session.id === 'string' ? session.id : ''
      if (!id) return { status: 'ignored', reason: 'no session id' }
      if (session.payment_status !== 'paid') return { status: 'ignored', reason: 'not paid' }
      const meta = (typeof session.metadata === 'object' && session.metadata !== null ? session.metadata : {}) as Record<string, unknown>
      const row = await purchase('stripe', id)
      const playerId = row ? (row.player_id as string) : typeof meta.player_id === 'string' ? meta.player_id : ''
      const code = row ? (row.product_code as string) : typeof meta.product === 'string' ? meta.product : ''
      if (!playerId || !code) return { status: 'ignored', reason: 'unknown purchase' }
      if (!(await deps.store.getPlayer(playerId))) return { status: 'ignored', reason: 'unknown player' }
      // An existing row keeps working after the product is switched off; a session without a row needs an active product.
      const product = await findProduct('stripe', code, row === undefined)
      if (!product) return { status: 'ignored', reason: 'unknown product' }
      const expectAmount = row && row.amount !== null && row.amount !== undefined ? Number(row.amount) : product.price
      const expectCurrency = String(row?.currency ?? product.currency).toLowerCase()
      if (Number(session.amount_total) !== expectAmount || String(session.currency ?? '').toLowerCase() !== expectCurrency) {
        log('error', `[economy] ${game}: stripe session ${id} amount/currency does not match the product, not granting`)
        return { status: 'ignored', reason: 'amount mismatch' }
      }
      const paymentRef = typeof session.payment_intent === 'string' ? session.payment_intent : undefined
      return grant('stripe', id, playerId, product, paymentRef ? { payment_ref: paymentRef } : {}, `st:${id}`)
    },

    async stripeRefunded(paymentIntent) {
      const row = await one('etc_purchases', [eq('provider', 'stripe'), eq('payment_ref', paymentIntent)])
      if (!row) return false
      await refund('stripe', row.external_id as string, `st:${row.external_id as string}`)
      return true
    },

    hasStripe: () => !!deps.stripe,
    async stripeVerify(rawBody, signature) {
      if (!deps.stripe) throw new EconomyUnavailable('stripe')
      return deps.stripe.verify(rawBody, signature)
    },
    onChange(fn) { listeners.push(fn) },
    start() { void catalog.refresh(); catalog.start() },
    stop() { catalog.stop() },
  }
}
