import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { createMemoryTableApi } from '../src/store/tables.ts'
import type { TableApi } from '../src/store/tables.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { createEconomyService } from '../src/economy/service.ts'
import type { EconomyService } from '../src/economy/service.ts'
import type { Wavedash } from '../src/economy/wavedash.ts'
import type { StripeBridge } from '../src/economy/stripe.ts'
import { createJwks } from '../src/economy/jwt.ts'
import { createWavedash } from '../src/economy/wavedash.ts'
import type { Rng } from '../src/economy/draw.ts'

/** Deterministic rng (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const CATALOG = {
  cards: [
    { id: '1', rarity: 'basic' }, { id: '2', rarity: 'basic' }, { id: '3', rarity: 'basic' },
    { id: '10', rarity: 'rare' }, { id: '11', rarity: 'rare' },
    { id: '20', rarity: 'epic' }, { id: '30', rarity: 'legendary' },
    { id: '99', rarity: 'basic', token: true },
  ],
  packs: {
    shop: {
      kind: 'random', size: 5, tiers: ['common', 'rare', 'epic', 'legendary'],
      weights: { common: 70, rare: 22, epic: 6.5, legendary: 1.5 }, tier_of: { basic: 'common' },
      guarantee: { slot: 'last', min_tier: 'rare' }, duplicate_refund: 3,
    },
    'story:a:1': { kind: 'fixed', cards: ['20', '1', '10'] },
  },
  rewards: { 'tuto:intro': { coins: 25 }, 'enc:*': { coins: 20 }, 'bonus:*': { coins: 500 }, 'story:a': { packs: { 'story:a:1': 1 } } },
}

export function productRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'coins', code: 'pack-shop', label: 'Pack', price: 100, currency: 'coins', grant_coins: 0,
    grant_packs: '{"shop":1}', active: true, sort_order: 0, ...over,
  }
}

export async function tenantWith(rows: Array<[string, Record<string, unknown>]> = []): Promise<ReturnType<typeof createMemoryTableApi>> {
  const api = createMemoryTableApi()
  await api.insert('etc_settings', { key: 'economy.catalog', value: JSON.stringify(CATALOG) })
  await api.insert('etc_products', productRow())
  await api.insert('etc_products', productRow({ code: 'pack-shop-5', price: 450, grant_packs: '{"shop":5}' }))
  await api.insert('etc_products', productRow({ provider: 'wavedash', code: 'coins-250', price: 200, currency: 'EUR', grant_coins: 250, grant_packs: '' }))
  await api.insert('etc_products', productRow({ provider: 'wavedash', code: 'bundle', price: 500, currency: 'EUR', grant_coins: 100, grant_packs: '{"shop":2}' }))
  await api.insert('etc_products', productRow({ provider: 'stripe', code: 'coins-250', price: 200, currency: 'EUR', grant_coins: 250, grant_packs: '' }))
  await api.insert('etc_publishers', { platform: 'wavedash', label: 'WD', external_id: 'game-wd-1', enabled: true })
  for (const [t, r] of rows) await api.insert(t, r)
  return api
}

export interface Rig {
  api: ReturnType<typeof createMemoryTableApi>
  svc: EconomyService
  store: ReturnType<typeof createMemoryStore>
  player(external: string, provider?: 'guest' | 'wavedash'): Promise<string>
  logs: string[]
}

export async function rig(opts: { wavedash?: Wavedash; stripe?: StripeBridge; seed?: number; api?: TableApi; now?: () => number } = {}): Promise<Rig> {
  const api = (opts.api ?? await tenantWith()) as ReturnType<typeof createMemoryTableApi>
  const store = createMemoryStore()
  const logs: string[] = []
  const svc = createEconomyService({
    game: 'g', api, store, wavedash: opts.wavedash, stripe: opts.stripe, rng: seeded(opts.seed ?? 7), now: opts.now,
    log: (l, m) => logs.push(`${l} ${m}`),
  })
  await svc.catalog.refresh()
  return {
    api, svc, store, logs,
    async player(external, provider = 'guest') {
      return (await store.getOrCreateByIdentity({ provider, external_id: external })).player.player_id
    },
  }
}

// --- RS256 / JWKS fixtures for Wavedash ---------------------------------------------------------------------

export interface Signer { kid: string; key: KeyObject; jwk: Record<string, unknown> }

export function newSigner(kid = 'k1'): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg: 'RS256' }
  return { kid, key: createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })), jwk }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function signJwt(s: Signer, payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = { alg: 'RS256', kid: s.kid, ...header }
  const data = `${b64(h)}.${b64(payload)}`
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), s.key).toString('base64url')}`
}

export const NOW_MS = 1_800_000_000_000
export const nowSec = () => Math.floor(NOW_MS / 1000)

export function receipt(s: Signer, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  return signJwt(s, {
    iss: 'https://auth.wavedash.com', aud: 'game-wd-1', sub: 'wd-user-1', gcid: 'gc1', env: 'PRODUCTION',
    event: 'purchase.completed', purchaseId: 'p1', ptype: 'CONSUMABLE', contentIdentifier: 'coins-250',
    created: nowSec(), iat: nowSec(), ...over,
  }, { typ: 'wavedash-purchase+jwt', ...header })
}

export function userJwt(s: Signer, over: Record<string, unknown> = {}): string {
  return signJwt(s, {
    iss: 'https://auth.wavedash.com', aud: 'gameplay.wavedash.com', sub: 'wd-user-1', gcid: 'gc1', scope: 'gameplay',
    iat: nowSec(), nbf: nowSec(), exp: nowSec() + 3600, ...over,
  })
}

/** A Wavedash whose JWKS and fulfill endpoint are served by a fake fetch. */
export function fakeWavedash(signers: Signer[], opts: { fulfill?: (id: string, body: unknown) => { status: number; body: unknown } } = {}) {
  const calls: { url: string; body?: unknown }[] = []
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (u.endsWith('/.well-known/jwks.json')) return Response.json({ keys: signers.map(s => s.jwk) })
    const m = /\/api\/purchases\/([^/]+)\/fulfill$/.exec(u)
    if (m) {
      const r = opts.fulfill ? opts.fulfill(decodeURIComponent(m[1]!), calls.at(-1)!.body) : { status: 200, body: { status: 'FULFILLED' } }
      return Response.json(r.body, { status: r.status })
    }
    return new Response('nope', { status: 404 })
  }) as typeof fetch
  const wd = createWavedash({ fetch: fakeFetch, now: () => NOW_MS, jwks: createJwks('https://auth.wavedash.com/.well-known/jwks.json', { fetch: fakeFetch, now: () => NOW_MS }) })
  return { wd, calls }
}
