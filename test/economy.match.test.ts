import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { parseMatchMessage } from '../src/match/messages.ts'
import { singleStoreRouter } from '../src/store/games.ts'
import { defaultVerifiers, verifyIdentityHook } from '../src/identity.ts'
import { economyRoutes } from '../src/economy/routes.ts'
import { fakeWavedash, newSigner, NOW_MS, receipt, rig, userJwt } from './economy.helpers.ts'

class FakeConn {
  sent: Record<string, unknown>[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void {}
  last(): Record<string, unknown> | undefined { return this.sent.at(-1) }
}
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)) }

async function world() {
  const signer = newSigner()
  const fw = fakeWavedash([signer])
  const r = await rig({ wavedash: fw.wd, now: () => NOW_MS })
  const deps = { now: () => NOW_MS, random: Math.random, log: () => {} }
  const hooks = { verifyIdentity: verifyIdentityHook(defaultVerifiers({ wavedash: fw.wd.identityVerifier() })) }
  const service = new MatchService(deps, singleStoreRouter(r.store, r.svc), hooks)
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const client = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    return { conn, send: async (m: Record<string, unknown>) => { hub.message(id, JSON.stringify(m)); await flush() } }
  }
  return { r, signer, client, fw }
}

test('messages: parsed strictly', () => {
  assert.deepEqual(parseMatchMessage({ t: 'eco_buy', op: 'o1', product: 'pack-shop' }), { t: 'eco_buy', op: 'o1', product: 'pack-shop', qty: 1 })
  for (const bad of [
    { t: 'eco_buy', product: 'x' }, { t: 'eco_buy', op: 'o', product: 'x y' }, { t: 'eco_buy', op: 'o', product: 'x', qty: 0 },
    { t: 'eco_buy', op: 'o', product: 'x', qty: 1.5 }, { t: 'eco_open', op: 'o' }, { t: 'eco_reward', reward_id: '' },
    { t: 'eco_wavedash' }, { t: 'eco_wavedash', receipt_jwt: 'a'.repeat(3001) }, { t: 'eco_stripe', product: 'p' },
    { t: 'eco_get', op: 'bad op' },
  ]) assert.ok('error' in (parseMatchMessage(bad) as object), JSON.stringify(bad))
})

test('economy needs authentication', async () => {
  const w = await world()
  const c = w.client()
  await c.send({ t: 'eco_get' })
  assert.deepEqual(c.conn.last(), { t: 'error', reason: 'auth_required' })
})

test('guest session: reward, shop, open, collection survive a reconnect', async () => {
  const w = await world()
  const token = 'guest-token-for-economy-1'
  const a = w.client()
  await a.send({ t: 'auth', provider: 'guest', token })
  await a.send({ t: 'eco_get', op: 'g1' })
  assert.deepEqual(a.conn.last(), { t: 'eco_state', op: 'g1', coins: 0, version: 0, packs: [], cards: {} })
  await a.send({ t: 'eco_reward', reward_id: 'bonus:1' })
  assert.equal(a.conn.last()!.coins, 500)
  await a.send({ t: 'eco_buy', op: 'b1', product: 'pack-shop-5' })
  assert.deepEqual([a.conn.last()!.t, a.conn.last()!.coins, a.conn.last()!.applied], ['eco_bought', 50, true])
  await a.send({ t: 'eco_buy', op: 'b1', product: 'pack-shop-5' })
  assert.deepEqual([a.conn.last()!.coins, a.conn.last()!.applied], [50, false])
  await a.send({ t: 'eco_buy', op: 'b2', product: 'pack-shop-5' })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'insufficient_funds', op: 'b2' })
  await a.send({ t: 'eco_open', op: 'o1', pack_type: 'shop' })
  const opened = a.conn.last()!
  assert.equal(opened.t, 'eco_opened')
  assert.equal((opened.cards as unknown[]).length, 5)
  await a.send({ t: 'eco_open', op: 'o1', pack_type: 'shop' })
  assert.deepEqual((a.conn.last()!.cards as unknown[]), opened.cards)
  assert.equal(a.conn.last()!.applied, false)
  await a.send({ t: 'eco_open', op: 'ox', pack_type: 'ghost' })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'unknown_pack', op: 'ox' })
  // a new connection of the same identity finds everything
  const b = w.client()
  await b.send({ t: 'auth', provider: 'guest', token })
  await b.send({ t: 'eco_get' })
  const st = b.conn.last()!
  assert.equal(st.t, 'eco_state')
  assert.deepEqual(st.packs, [{ pack_type: 'shop', quantity: 4 }])
  assert.equal(Object.values(st.cards as Record<string, number>).reduce((x, y) => x + y, 0), 5)
  // another player's profile is separate
  const other = w.client()
  await other.send({ t: 'auth', provider: 'guest', token: 'guest-token-for-economy-2' })
  await other.send({ t: 'eco_get' })
  assert.deepEqual([other.conn.last()!.coins, other.conn.last()!.cards], [0, {}])
})

test('products are listed for the client', async () => {
  const w = await world()
  const a = w.client()
  await a.send({ t: 'auth', provider: 'guest', token: 'guest-token-for-economy-3' })
  await a.send({ t: 'eco_products' })
  const products = a.conn.last()!.products as Array<{ provider: string; code: string }>
  assert.deepEqual(products.map(p => `${p.provider}:${p.code}`).sort(), ['coins:pack-shop', 'coins:pack-shop-5', 'stripe:coins-250', 'wavedash:bundle', 'wavedash:coins-250'])
})

test('wavedash session: receipt over the socket credits, error codes are specific, a webhook pushes the new state', async () => {
  const w = await world()
  const a = w.client()
  await a.send({ t: 'auth', provider: 'wavedash', token: userJwt(w.signer), name: 'Kevin' })
  assert.equal(a.conn.sent[0]!.t, 'authed')
  await a.send({ t: 'eco_wavedash', op: 'w1', receipt_jwt: receipt(w.signer), user_jwt: userJwt(w.signer) })
  assert.deepEqual([a.conn.last()!.t, a.conn.last()!.status, a.conn.last()!.coins, a.conn.last()!.op], ['eco_purchase', 'granted', 250, 'w1'])
  await a.send({ t: 'eco_wavedash', receipt_jwt: receipt(w.signer) })
  assert.equal(a.conn.last()!.applied, false)
  await a.send({ t: 'eco_wavedash', receipt_jwt: receipt(w.signer, { sub: 'someone-else', purchaseId: 'p9' }) })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'receipt_mismatch' })
  await a.send({ t: 'eco_wavedash', receipt_jwt: receipt(w.signer, { env: 'PLAYTEST', purchaseId: 'p10' }) })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'not_production' })
  await a.send({ t: 'eco_wavedash', receipt_jwt: receipt(newSigner(), { purchaseId: 'p11' }) })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'bad_receipt' })
  await a.send({ t: 'eco_wavedash', receipt_jwt: receipt(w.signer, { contentIdentifier: 'mystery', purchaseId: 'p12' }) })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'unknown_product' })
  // a purchase delivered by the webhook while the player is connected is pushed
  const hook = economyRoutes({ backends: () => [{ game: 'g', store: w.r.store, queues: () => ['quick'], economy: w.r.svc }] }).find(x => x.path === '/webhooks/wavedash')!
  const before = a.conn.sent.length
  await hook.handle({ body: JSON.stringify({ receiptJwt: receipt(w.signer, { purchaseId: 'p20', contentIdentifier: 'bundle' }) }), headers: {} })
  await flush()
  const pushed = a.conn.sent.slice(before).find(m => m.t === 'eco_state')!
  assert.equal(pushed.coins, 350)
})

test('guest cannot use a wavedash receipt; stripe is refused when not configured', async () => {
  const w = await world()
  const a = w.client()
  await a.send({ t: 'auth', provider: 'guest', token: 'guest-token-for-economy-4' })
  await a.send({ t: 'eco_wavedash', receipt_jwt: receipt(w.signer) })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'receipt_mismatch' })
  await a.send({ t: 'eco_stripe', product: 'coins-250', return_url: 'https://game.example/' })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'economy_unavailable' })
})
