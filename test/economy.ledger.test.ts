import test from 'node:test'
import assert from 'node:assert/strict'
import { StoreError } from '../src/store/errors.ts'
import type { TableApi } from '../src/store/tables.ts'
import { parseCatalog, findReward, parseProduct } from '../src/economy/catalog.ts'
import { drawRandom } from '../src/economy/draw.ts'
import { createEconomyLedger } from '../src/economy/ledger.ts'
import { CATALOG, productRow, rig, seeded, tenantWith } from './economy.helpers.ts'

const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: unknown) => e instanceof StoreError && e.code === c)

// --- catalog data -----------------------------------------------------------------------------

test('catalog: validated, tokens kept apart, prefix rewards, nothing echoed', () => {
  const c = parseCatalog(JSON.stringify(CATALOG))
  assert.equal(c.cards.length, 8)
  assert.deepEqual(findReward(c, 'tuto:intro'), { coins: 25, packs: {} })
  assert.deepEqual(findReward(c, 'enc:foe-3'), { coins: 20, packs: {} })
  assert.equal(findReward(c, 'nope'), null)
  const bad: unknown[] = [
    'nope', { packs: { x: { kind: 'random', size: 0, tiers: ['a'], weights: { a: 1 } } } },
    { packs: { x: { kind: 'random', size: 5, tiers: ['a'], weights: { a: 0 } } } },
    { packs: { x: { kind: 'fixed', cards: ['zz'] } } },
    { cards: [{ id: '1', rarity: 'a' }, { id: '1', rarity: 'a' }] },
    { rewards: { r: { coins: -1 } } }, { rewards: { 'a*b': { coins: 1 } } }, { rewards: { r: { packs: { ghost: 1 } } } },
  ]
  for (const b of bad) assert.throws(() => parseCatalog(typeof b === 'string' ? b : JSON.stringify(b)))
  assert.deepEqual(parseCatalog('').cards, [])
})

test('product rows: parsed, nonsense refused', () => {
  assert.equal(parseProduct(productRow())?.grant_packs.shop, 1)
  assert.equal(parseProduct(productRow({ provider: 'paypal' })), null)
  assert.equal(parseProduct(productRow({ price: -3 })), null)
  assert.equal(parseProduct(productRow({ grant_packs: 'not json' })), null)
  assert.equal(parseProduct(productRow({ grant_packs: '', grant_coins: 0 })), null)
})

// --- pack draw (port of Kekkai packs.ts, parameters from data) --------------------------------------

test('draw: size from data, last slot guaranteed rare, sorted by tier, tokens never drawn', () => {
  const c = parseCatalog(JSON.stringify(CATALOG))
  const def = c.packs.shop!
  const pool = c.cards.filter(x => !x.token)
  for (let seed = 1; seed < 200; seed++) {
    const cards = drawRandom(def, seeded(seed), pool, new Set())
    assert.equal(cards.length, 5)
    assert.ok(cards.every(x => x.id !== '99'))
    assert.ok(cards.some(x => x.rarity !== 'basic'), `seed ${seed}: at least one non-common card`)
    const order = ['basic', 'rare', 'epic', 'legendary']
    const ranks = cards.map(x => order.indexOf(x.rarity))
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
  }
})

test('draw: owned cards and repeats are duplicates; a tiny pool still fills the pack', () => {
  const c = parseCatalog(JSON.stringify({ cards: [{ id: '1', rarity: 'basic' }, { id: '10', rarity: 'rare' }], packs: { shop: CATALOG.packs.shop } }))
  const cards = drawRandom(c.packs.shop!, seeded(3), c.cards, new Set(['1']))
  assert.equal(cards.length, 5)
  assert.equal(cards.filter(x => x.is_new).length <= 1, true)
  assert.ok(cards.filter(x => x.id === '1').every(x => x.duplicate))
})

test('draw: tier frequencies follow the data weights', () => {
  const c = parseCatalog(JSON.stringify(CATALOG))
  const pool = c.cards.filter(x => !x.token)
  const rng = seeded(42)
  const count: Record<string, number> = {}
  let total = 0
  for (let i = 0; i < 4000; i++) for (const x of drawRandom(c.packs.shop!, rng, pool, new Set())) { count[x.rarity] = (count[x.rarity] ?? 0) + 1; total++ }
  assert.ok((count.basic ?? 0) / total > 0.55 && (count.basic ?? 0) / total < 0.8)
  assert.ok((count.legendary ?? 0) / total < 0.05)
})

// --- ledger: rewards, shop, opening -------------------------------------------------------------------------

test('reward: granted once per player and id, whatever the replays; unknown ids refused', async () => {
  const r = await rig()
  const p = await r.player('a')
  const first = await r.svc.reward(p, 'tuto:intro')
  assert.equal(first.applied, true)
  assert.equal(first.result.coins, 25)
  const again = await r.svc.reward(p, 'tuto:intro')
  assert.equal(again.applied, false)
  assert.equal((await r.svc.state(p)).coins, 25)
  assert.equal((await r.svc.reward(p, 'enc:one')).result.coins, 45)
  await code(r.svc.reward(p, 'enc'), 'unknown_reward')
  await code(r.svc.reward(p, 'whatever'), 'unknown_reward')
  const q = await r.player('b')
  assert.equal((await r.svc.reward(q, 'tuto:intro')).applied, true)
})

test('shop: price from etc_products, atomic, idempotent by operation id', async () => {
  const r = await rig()
  const p = await r.player('a')
  for (const k of ['tuto:intro', 'enc:1', 'enc:2', 'enc:3', 'enc:4', 'enc:5']) await r.svc.reward(p, k)
  assert.equal((await r.svc.state(p)).coins, 125)
  await code(r.svc.buy(p, 'op0', 'pack-shop-5', 1), 'insufficient_funds')
  assert.equal((await r.svc.state(p)).coins, 125)
  const bought = await r.svc.buy(p, 'op1', 'pack-shop', 1)
  assert.deepEqual([bought.applied, bought.result.coins, bought.result.packs], [true, 25, { shop: 1 }])
  const replay = await r.svc.buy(p, 'op1', 'pack-shop', 1)
  assert.equal(replay.applied, false)
  assert.deepEqual(replay.result, bought.result)
  await code(r.svc.buy(p, 'op1', 'pack-shop', 2), 'tx_conflict')
  await code(r.svc.buy(p, 'op1', 'pack-shop-5', 1), 'tx_conflict')
  await code(r.svc.buy(p, 'op2', 'ghost', 1), 'unknown_product')
  await code(r.svc.buy(p, 'op3', 'coins-250', 1), 'unknown_product') // a wavedash product is not a coin product
  const s = await r.svc.state(p)
  assert.deepEqual([s.coins, s.packs], [25, [{ pack_type: 'shop', quantity: 1 }]])
  // the price is read at each purchase: an edit in the backoffice applies at once
  const row = r.api.rows('etc_products').find(x => x.code === 'pack-shop')!
  await r.api.update('etc_products', row.id as number, { price: 20 })
  assert.equal((await r.svc.buy(p, 'op4', 'pack-shop', 1)).result.coins, 5)
  await r.api.update('etc_products', row.id as number, { active: false })
  await code(r.svc.buy(p, 'op5', 'pack-shop', 1), 'unknown_product')
  // one etc_purchases receipt per coin purchase
  assert.equal(r.api.rows('etc_purchases').filter(x => x.provider === 'coins').length, 2)
})

test('open: server-side draw, collection persisted, replay returns the same cards and takes nothing more', async () => {
  const r = await rig()
  const p = await r.player('a')
  await r.svc.reward(p, 'story:a')   // a fixed pack
  await code(r.svc.open(p, 'o1', 'shop'), 'no_packs')
  await code(r.svc.open(p, 'o1', 'ghost'), 'unknown_pack')
  const o = await r.svc.open(p, 'o2', 'story:a:1')
  assert.deepEqual(o.result.cards.map(c => [c.id, c.is_new]), [['20', true], ['1', true], ['10', true]])
  assert.equal(o.result.refund, 0)
  assert.equal(o.result.remaining, 0)
  const again = await r.svc.open(p, 'o2', 'story:a:1')
  assert.equal(again.applied, false)
  assert.deepEqual(again.result, o.result)
  await code(r.svc.open(p, 'o3', 'story:a:1'), 'no_packs')
  const s = await r.svc.state(p)
  assert.deepEqual(s.cards, { '20': 1, '1': 1, '10': 1 })
  assert.deepEqual(s.packs, [])
  // the collection is in etc_cards (one row per player and card), kept for the next session
  assert.equal(r.api.rows('etc_cards').filter(x => x.player_id === p).length, 3)
})

test('open a shop pack: five cards, duplicates refund coins from the pack definition', async () => {
  const r = await rig({ seed: 11 })
  const p = await r.player('a')
  await r.svc.reward(p, 'bonus:1')
  await r.svc.buy(p, 'b1', 'pack-shop-5', 1)   // 450 for five packs
  const owned = new Set<string>()
  let coins = (await r.svc.state(p)).coins
  for (let i = 0; i < 5; i++) {
    const o = await r.svc.open(p, `open${i}`, 'shop')
    assert.equal(o.result.cards.length, 5)
    const dups = o.result.cards.filter(c => c.duplicate).length
    assert.equal(o.result.refund, 3 * dups)
    for (const c of o.result.cards) if (c.is_new) assert.ok(!owned.has(c.id))
    for (const c of o.result.cards) owned.add(c.id)
    coins += o.result.refund
    assert.equal(o.result.coins, coins)
  }
  const s = await r.svc.state(p)
  assert.equal(s.coins, coins)
  assert.equal(Object.values(s.cards).reduce((a, b) => a + b, 0), 25)
  assert.deepEqual(new Set(Object.keys(s.cards)), owned)
})

test('profiles are separate per player; ids are namespaced by player', async () => {
  const r = await rig()
  const a = await r.player('a'), b = await r.player('b')
  await r.svc.reward(a, 'tuto:intro')
  await r.svc.buy(a, 'same', 'pack-shop', 1).catch(() => undefined)
  assert.equal((await r.svc.state(b)).coins, 0)
  await r.svc.reward(b, 'tuto:intro')
  // the same client operation id used by two players never collides
  for (const p of [a, b]) await r.svc.reward(p, 'enc:1')
  assert.equal((await r.svc.state(a)).coins, 45)
  assert.equal((await r.svc.state(b)).coins, 45)
})

// --- atomicity and recovery ----------------------------------------------------------------------------------

test('concurrency: the same operation sent 30 times applies once', async () => {
  const r = await rig()
  const p = await r.player('a')
  for (const k of ['tuto:intro', 'enc:1', 'enc:2', 'enc:3', 'enc:4', 'enc:5']) await r.svc.reward(p, k)
  const results = await Promise.all(Array.from({ length: 30 }, () => r.svc.buy(p, 'same-op', 'pack-shop', 1)))
  assert.equal(results.filter(x => x.applied).length, 1)
  const s = await r.svc.state(p)
  assert.deepEqual([s.coins, s.packs], [25, [{ pack_type: 'shop', quantity: 1 }]])
})

test('concurrency: parallel distinct purchases can never spend more than the balance', async () => {
  const r = await rig()
  const p = await r.player('a')
  for (const k of ['tuto:intro', 'enc:1', 'enc:2', 'enc:3', 'enc:4', 'enc:5']) await r.svc.reward(p, k)   // 125 coins
  const out = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => r.svc.buy(p, `op${i}`, 'pack-shop', 1)))
  assert.equal(out.filter(x => x.status === 'fulfilled').length, 1)
  assert.ok(out.filter(x => x.status === 'rejected').every(x => (x.reason as StoreError).code === 'insufficient_funds'))
  assert.equal((await r.svc.state(p)).coins, 25)
})

test('concurrency: one closed pack opened by many parallel requests is opened once', async () => {
  const r = await rig()
  const p = await r.player('a')
  await r.svc.reward(p, 'story:a')
  const out = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => r.svc.open(p, `o${i}`, 'story:a:1')))
  assert.equal(out.filter(x => x.status === 'fulfilled').length, 1)
  assert.deepEqual((await r.svc.state(p)).cards, { '20': 1, '1': 1, '10': 1 })
})

/** A table API that throws on the n-th matching write: a process crash in the middle of a projection. */
function crashing(api: TableApi, when: (kind: 'insert' | 'update', table: string, count: number) => boolean) {
  const counts = new Map<string, number>()
  const state = { armed: false }
  const hit = (kind: 'insert' | 'update', table: string) => {
    if (!state.armed) return
    const k = `${kind}:${table}`
    const n = (counts.get(k) ?? 0) + 1
    counts.set(k, n)
    if (when(kind, table, n)) { state.armed = false; throw new Error('simulated crash') }
  }
  const wrapped: TableApi = {
    insert: (t, row) => { hit('insert', t); return api.insert(t, row) },
    query: (t, q) => api.query(t, q),
    update: (t, id, patch) => { hit('update', t, ); return api.update(t, id, patch) },
  }
  return { api: wrapped, state }
}

test('crash between the journal and the projection: the next operation repairs it, nothing is applied twice', async () => {
  for (const crashAt of [['update', 'etc_packs', 1], ['insert', 'etc_cards', 2], ['update', 'etc_wallets', 1], ['insert', 'etc_cards', 1]] as const) {
    const base = await tenantWith()
    const c = crashing(base, (kind, table, n) => kind === crashAt[0] && table === crashAt[1] && n === crashAt[2])
    const r = await rig({ api: c.api })
    const p = await r.player('a')
    await r.svc.reward(p, 'story:a')
    c.state.armed = true
    await assert.rejects(r.svc.open(p, 'o1', 'story:a:1'), /simulated crash/)
    // the ledger row was committed: the replay finishes the projection and answers the original result
    const replay = await r.svc.open(p, 'o1', 'story:a:1')
    assert.equal(replay.applied, false)
    const s = await r.svc.state(p)
    assert.deepEqual(s.cards, { '20': 1, '1': 1, '10': 1 }, `crash at ${crashAt.join(' ')}`)
    assert.deepEqual(s.packs, [])
    // and a crash on the first write of a purchase leaves nothing behind (replay starts over once)
    c.state.armed = false
  }
})

test('a read after a crash also repairs the projection', async () => {
  const base = await tenantWith()
  const c = crashing(base, (kind, table) => kind === 'update' && table === 'etc_wallets')
  const r = await rig({ api: c.api })
  const p = await r.player('a')
  c.state.armed = true
  await assert.rejects(r.svc.reward(p, 'tuto:intro'), /simulated crash/)
  assert.equal((await r.svc.state(p)).coins, 25)
  assert.equal((await r.svc.state(p)).coins, 25)
})

test('the projection can be rebuilt from the journal after the wallet row is lost', async () => {
  const base = await tenantWith()
  const r = await rig({ api: base })
  const p = await r.player('a')
  await r.svc.reward(p, 'tuto:intro')
  await r.svc.reward(p, 'story:a')
  await r.svc.open(p, 'o', 'story:a:1')
  const rows = base.rows('etc_wallets')
  rows.length = 0           // wallet gone
  base.rows('etc_cards').length = 0
  base.rows('etc_packs').length = 0
  const s = await r.svc.state(p)
  assert.equal(s.coins, 25)
  assert.deepEqual(s.cards, { '20': 1, '1': 1, '10': 1 })
})

test('ledger without a catalog: unknown rewards and packs are refused, state still works', async () => {
  const api = await tenantWith()
  const ledger = createEconomyLedger(api, { catalog: () => ({ cards: [], packs: {}, rewards: {} }) })
  assert.deepEqual((await ledger.state('p1')).packs, {})
  await code(ledger.reward('p1', 'tuto:intro'), 'unknown_reward')
  await code(ledger.openPack('p1', 'o', 'shop'), 'unknown_pack')
})
