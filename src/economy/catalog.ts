// The catalog (card pool, pack rules, rewards) is data: the JSON text of etc_settings key `economy.catalog`,
// validated here, read at start-up and refreshed on a timer (a bad edit keeps the previous catalog).

import type { Row, TableApi } from '../store/tables.ts'
import { EMPTY_CATALOG } from './types.ts'
import type { CardDef, Catalog, PackDef, Product, ProductProvider, RewardDef } from './types.ts'

export const CATALOG_KEY = 'economy.catalog'
export const CATALOG_REFRESH_MS = 60_000
const ID_RE = /^[A-Za-z0-9:_.-]{1,64}$/
const MAX_COUNT = 1000

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const posInt = (v: unknown, max = MAX_COUNT): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max

function counts(v: unknown, what: string): Record<string, number> {
  if (v === undefined || v === null) return {}
  if (!isObj(v)) throw new Error(`${what} must be an object {"<pack_type>": count}`)
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v)) {
    if (!ID_RE.test(k)) throw new Error(`${what}: bad pack type "${k}"`)
    if (!posInt(n)) throw new Error(`${what}.${k} must be an integer in 0..${MAX_COUNT}`)
    if (n > 0) out[k] = n
  }
  return out
}

function parsePack(type: string, raw: unknown): PackDef {
  if (!isObj(raw)) throw new Error(`packs.${type} must be an object`)
  const kind = raw.kind ?? 'random'
  if (kind !== 'random' && kind !== 'fixed') throw new Error(`packs.${type}.kind must be random or fixed`)
  const refund = raw.duplicate_refund ?? 0
  if (!posInt(refund, 1_000_000)) throw new Error(`packs.${type}.duplicate_refund must be a non-negative integer`)
  if (kind === 'fixed') {
    if (!Array.isArray(raw.cards) || raw.cards.length < 1 || raw.cards.length > 64 || raw.cards.some(c => typeof c !== 'string' || !ID_RE.test(c))) {
      throw new Error(`packs.${type}.cards must be 1..64 card ids`)
    }
    return { kind, size: raw.cards.length, tiers: [], weights: {}, tier_of: {}, guarantee: null, duplicate_refund: refund, cards: raw.cards as string[] }
  }
  const size = raw.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > 64) throw new Error(`packs.${type}.size must be 1..64`)
  if (!Array.isArray(raw.tiers) || raw.tiers.length < 1 || raw.tiers.some(t => typeof t !== 'string' || !ID_RE.test(t)) || new Set(raw.tiers).size !== raw.tiers.length) {
    throw new Error(`packs.${type}.tiers must be a list of distinct tier names, lowest first`)
  }
  const tiers = raw.tiers as string[]
  if (!isObj(raw.weights)) throw new Error(`packs.${type}.weights must be an object {"<tier>": weight}`)
  const weights: Record<string, number> = {}
  for (const t of tiers) {
    const w = raw.weights[t]
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) throw new Error(`packs.${type}.weights.${t} must be a number >= 0`)
    weights[t] = w
  }
  if (tiers.every(t => weights[t] === 0)) throw new Error(`packs.${type}.weights: at least one weight must be positive`)
  const tier_of: Record<string, string> = {}
  if (raw.tier_of !== undefined) {
    if (!isObj(raw.tier_of)) throw new Error(`packs.${type}.tier_of must be an object {"<rarity>": "<tier>"}`)
    for (const [r, t] of Object.entries(raw.tier_of)) {
      if (typeof t !== 'string' || !tiers.includes(t)) throw new Error(`packs.${type}.tier_of.${r} must name one of the tiers`)
      tier_of[r] = t
    }
  }
  let guarantee: PackDef['guarantee'] = null
  if (raw.guarantee !== undefined && raw.guarantee !== null) {
    if (!isObj(raw.guarantee) || raw.guarantee.slot !== 'last' || typeof raw.guarantee.min_tier !== 'string' || !tiers.includes(raw.guarantee.min_tier)) {
      throw new Error(`packs.${type}.guarantee must be {"slot":"last","min_tier":"<tier>"}`)
    }
    guarantee = { slot: 'last', min_tier: raw.guarantee.min_tier }
  }
  return { kind, size, tiers, weights, tier_of, guarantee, duplicate_refund: refund, cards: [] }
}

/** Validates the catalog JSON; throws a message that names the faulty field and never echoes data. */
export function parseCatalog(text: string | null | undefined): Catalog {
  if (text === null || text === undefined || text.trim() === '') return EMPTY_CATALOG
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('economy.catalog is not valid JSON') }
  if (!isObj(raw)) throw new Error('economy.catalog must be a JSON object')
  const cards: CardDef[] = []
  const seen = new Set<string>()
  const rawCards = raw.cards ?? []
  if (!Array.isArray(rawCards) || rawCards.length > 20_000) throw new Error('economy.catalog.cards must be a list')
  for (const c of rawCards) {
    const o = isObj(c) ? c : null
    const id = o ? (typeof o.id === 'number' ? String(o.id) : o.id) : null
    if (typeof id !== 'string' || !ID_RE.test(id) || typeof o?.rarity !== 'string' || !ID_RE.test(o.rarity)) throw new Error('economy.catalog.cards: each card needs an id and a rarity')
    if (seen.has(id)) throw new Error(`economy.catalog.cards: duplicate id ${id}`)
    seen.add(id)
    if (o.source !== undefined && (typeof o.source !== 'string' || !ID_RE.test(o.source))) throw new Error(`economy.catalog.cards: bad source on card ${id}`)
    cards.push({ id, rarity: o.rarity, ...(o.token === true ? { token: true } : {}), ...(typeof o.source === 'string' ? { source: o.source } : {}) })
  }
  const packs: Record<string, PackDef> = {}
  if (raw.packs !== undefined) {
    if (!isObj(raw.packs)) throw new Error('economy.catalog.packs must be an object')
    for (const [type, def] of Object.entries(raw.packs)) {
      if (!ID_RE.test(type)) throw new Error(`economy.catalog.packs: bad pack type "${type}"`)
      const p = parsePack(type, def)
      for (const id of p.cards) if (!seen.has(id)) throw new Error(`packs.${type}.cards: unknown card ${id}`)
      packs[type] = p
    }
  }
  const rewards: Record<string, RewardDef> = {}
  if (raw.rewards !== undefined) {
    if (!isObj(raw.rewards)) throw new Error('economy.catalog.rewards must be an object')
    for (const [id, def] of Object.entries(raw.rewards)) {
      if (!/^[A-Za-z0-9:_.*-]{1,96}$/.test(id) || (id.includes('*') && !id.endsWith('*'))) throw new Error(`economy.catalog.rewards: bad reward id "${id}"`)
      if (!isObj(def)) throw new Error(`rewards.${id} must be an object`)
      const coins = def.coins ?? 0
      if (!posInt(coins, 1_000_000)) throw new Error(`rewards.${id}.coins must be a non-negative integer`)
      const rp = counts(def.packs, `rewards.${id}.packs`)
      for (const t of Object.keys(rp)) if (!packs[t]) throw new Error(`rewards.${id}.packs: unknown pack type ${t}`)
      if (coins === 0 && Object.keys(rp).length === 0) throw new Error(`rewards.${id} grants nothing`)
      rewards[id] = { coins, packs: rp }
    }
  }
  return { cards, packs, rewards }
}

/** Reward definition for an id: exact match first, then the longest `prefix*` entry. */
export function findReward(catalog: Catalog, id: string): RewardDef | null {
  const exact = catalog.rewards[id]
  if (exact) return exact
  let best: string | null = null
  for (const key of Object.keys(catalog.rewards)) {
    if (key.endsWith('*') && id.startsWith(key.slice(0, -1)) && (best === null || key.length > best.length)) best = key
  }
  return best ? catalog.rewards[best]! : null
}

/** Parses a row of etc_products; null when the row is unusable (never throws on bad data). */
export function parseProduct(row: Row): Product | null {
  const provider = row.provider
  if (provider !== 'wavedash' && provider !== 'stripe' && provider !== 'coins') return null
  if (typeof row.code !== 'string' || row.code === '') return null
  const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isSafeInteger(n) && n >= 0 ? n : NaN }
  const price = num(row.price), grantCoins = num(row.grant_coins)
  if (Number.isNaN(price) || Number.isNaN(grantCoins)) return null
  let packs: Record<string, number> = {}
  try {
    const raw = typeof row.grant_packs === 'string' && row.grant_packs.trim() !== '' ? JSON.parse(row.grant_packs) : {}
    packs = counts(raw, 'grant_packs')
  } catch { return null }
  if (grantCoins === 0 && Object.keys(packs).length === 0) return null
  return {
    provider: provider as ProductProvider, code: row.code, label: typeof row.label === 'string' ? row.label : row.code,
    price, currency: typeof row.currency === 'string' ? row.currency : '', grant_coins: grantCoins, grant_packs: packs,
    active: row.active !== false,
  }
}

export interface CatalogHandle {
  current(): Catalog
  refresh(): Promise<'ok' | 'empty' | 'invalid' | 'failed'>
  start(): void
  stop(): void
}

export function createCatalog(api: TableApi, opts: { game: string; intervalMs?: number; log?: (level: string, msg: string) => void }): CatalogHandle {
  let catalog = EMPTY_CATALOG
  let timer: ReturnType<typeof setInterval> | null = null
  const log = opts.log ?? (() => {})
  const handle: CatalogHandle = {
    current: () => catalog,
    async refresh() {
      let row: Row | undefined
      try {
        row = (await api.query('etc_settings', { filters: [{ field: 'key', op: 'eq', value: CATALOG_KEY }], size: 1 }))[0]
      } catch {
        log('error', `[economy] ${opts.game}: etc_settings read failed, keeping the current catalog`)
        return 'failed'
      }
      if (!row || typeof row.value !== 'string' || row.value.trim() === '') return 'empty'
      try {
        catalog = parseCatalog(row.value)
      } catch (e) {
        log('error', `[economy] ${opts.game}: ${(e as Error).message}, keeping the current catalog`)
        return 'invalid'
      }
      return 'ok'
    },
    start() {
      if (timer) return
      timer = setInterval(() => { void handle.refresh() }, opts.intervalMs ?? CATALOG_REFRESH_MS)
      timer.unref()
    },
    stop() { if (timer) clearInterval(timer); timer = null },
  }
  return handle
}
