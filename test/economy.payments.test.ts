import test from 'node:test'
import assert from 'node:assert/strict'
import { StoreError } from '../src/store/errors.ts'
import { WavedashError } from '../src/economy/wavedash.ts'
import { economyRoutes } from '../src/economy/routes.ts'
import { verifyJwt, createJwks, JwtError } from '../src/economy/jwt.ts'
import type { StripeBridge } from '../src/economy/stripe.ts'
import { defaultVerifiers, verifyIdentityHook } from '../src/identity.ts'
import { fakeWavedash, newSigner, NOW_MS, nowSec, receipt, rig, signJwt, tenantWith, userJwt } from './economy.helpers.ts'

const wdCode = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: unknown) => e instanceof WavedashError && e.code === c)
const storeCode = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: unknown) => e instanceof StoreError && e.code === c)

async function wdRig(opts: Parameters<typeof fakeWavedash>[1] = {}) {
  const signer = newSigner()
  const fw = fakeWavedash([signer], opts)
  const r = await rig({ wavedash: fw.wd, now: () => NOW_MS })
  const player = await r.player('wd-user-1', 'wavedash')
  return { signer, ...fw, r, player }
}

// --- JWT / JWKS --------------------------------------------------------------------------------------------

test('jwt: only RS256 with a known key, right issuer, audience, typ and a valid signature', async () => {
  const s = newSigner(), other = newSigner('k1')
  const { wd } = fakeWavedash([s])
  const ok = receipt(s)
  assert.equal((await wd.verifyReceipt(ok, { gameIds: ['game-wd-1'], allowPlaytest: false })).purchaseId, 'p1')
  const opts = { gameIds: ['game-wd-1'], allowPlaytest: false }
  await wdCode(wd.verifyReceipt(receipt(other), opts), 'bad_receipt')                                  // signed by another key (same kid)
  await wdCode(wd.verifyReceipt(receipt(s, { aud: 'someone-else' }), opts), 'bad_receipt')
  await wdCode(wd.verifyReceipt(receipt(s, { iss: 'https://evil.example' }), opts), 'bad_receipt')
  await wdCode(wd.verifyReceipt(receipt(s, {}, { typ: 'JWT' }), opts), 'bad_receipt')                  // a user JWT cannot pass as a receipt
  await wdCode(wd.verifyReceipt(userJwt(s), opts), 'bad_receipt')
  await wdCode(wd.verifyReceipt(receipt(s, {}, { alg: 'HS256' }), opts), 'bad_receipt')
  await wdCode(wd.verifyReceipt(receipt(s, {}, { alg: 'none' }), opts), 'bad_receipt')
  await wdCode(wd.verifyReceipt(receipt(s, {}, { kid: 'ghost' }), opts), 'bad_receipt')
  await wdCode(wd.verifyReceipt('not.a.jwt', opts), 'bad_receipt')
  await wdCode(wd.verifyReceipt(ok.slice(0, -4) + 'AAAA', opts), 'bad_receipt')                       // tampered signature
  await wdCode(wd.verifyReceipt(ok, { gameIds: [], allowPlaytest: false }), 'unknown_game')
  await wdCode(wd.verifyReceipt(receipt(s, { env: 'PLAYTEST' }), opts), 'not_production')
  assert.equal((await wd.verifyReceipt(receipt(s, { env: 'PLAYTEST' }), { ...opts, allowPlaytest: true })).env, 'PLAYTEST')
  await wdCode(wd.verifyReceipt(receipt(s, { ptype: 'DURABLE' }), opts), 'not_consumable')
  await wdCode(wd.verifyReceipt(receipt(s, { purchaseId: undefined }), opts), 'bad_receipt')
  await wdCode(wd.verifyReceipt(receipt(s, { event: 'purchase.exploded' }), opts), 'bad_receipt')
})

test('jwt: user token needs exp in the future and the gameplay audience; unknown kid refetches the JWKS once', async () => {
  const s = newSigner()
  const { wd } = fakeWavedash([s])
  assert.equal((await wd.verifyUser(userJwt(s))).sub, 'wd-user-1')
  await wdCode(wd.verifyUser(userJwt(s, { exp: nowSec() - 3600 })), 'bad_user_jwt')
  await wdCode(wd.verifyUser(userJwt(s, { aud: 'x' })), 'bad_user_jwt')
  let fetches = 0
  const late = newSigner('k2')
  const f = (async () => { fetches++; return Response.json({ keys: fetches === 1 ? [s.jwk] : [s.jwk, late.jwk] }) }) as unknown as typeof fetch
  const jwks = createJwks('https://x/jwks', { fetch: f, now: () => NOW_MS, minRefreshMs: 0 })
  const checks = { iss: 'https://auth.wavedash.com', aud: ['gameplay.wavedash.com'], typ: null, now: NOW_MS }
  await verifyJwt(userJwt(s), jwks, checks)
  await verifyJwt(userJwt(late), jwks, checks)   // rotated key: found after one refetch
  assert.equal(fetches, 2)
  await assert.rejects(verifyJwt(signJwt(late, { iss: 'https://auth.wavedash.com', aud: 'gameplay.wavedash.com' }, { kid: 'nope' }), jwks, checks), (e: unknown) => e instanceof JwtError)
  const down = createJwks('https://x/jwks', { fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch, now: () => NOW_MS })
  await assert.rejects(verifyJwt(userJwt(s), down, checks), JwtError)   // fail closed
})

test('wavedash identity: a valid user JWT logs the player in as provider wavedash', async () => {
  const s = newSigner()
  const { wd } = fakeWavedash([s])
  const hook = verifyIdentityHook(defaultVerifiers({ wavedash: wd.identityVerifier() }))
  assert.deepEqual(await hook('wavedash', userJwt(s), 'Kevin'), { provider: 'wavedash', external_id: 'wd-user-1', display_name: 'Kevin' })
  await assert.rejects(hook('wavedash', 'garbage'))
  await assert.rejects(hook('itch', 'x'))   // itch stays unconfigured
})

// --- Wavedash purchases: client path ------------------------------------------------------------------------

test('wavedash client purchase: credited once, replays and double delivery add nothing', async () => {
  const { signer, r, player } = await wdRig()
  const rc = receipt(signer)
  const first = await r.svc.wavedashFromClient(player, rc, userJwt(signer))
  assert.deepEqual([first.status, first.applied, first.coins, first.granted], ['granted', true, 250, { coins: 250, packs: {} }])
  const again = await r.svc.wavedashFromClient(player, rc, userJwt(signer))
  assert.equal(again.applied, false)
  assert.equal((await r.svc.state(player)).coins, 250)
  const row = r.api.rows('etc_purchases')[0]!
  assert.deepEqual([row.provider, row.external_id, row.status, row.product_code, row.player_id], ['wavedash', 'p1', 'granted', 'coins-250', player])
  assert.equal(r.api.rows('etc_purchases').length, 1)
})

test('wavedash: packs and coins of a bundle come from etc_products', async () => {
  const { signer, r, player } = await wdRig()
  await r.svc.wavedashFromClient(player, receipt(signer, { purchaseId: 'p2', contentIdentifier: 'bundle' }), undefined)
  const s = await r.svc.state(player)
  assert.deepEqual([s.coins, s.packs], [100, [{ pack_type: 'shop', quantity: 2 }]])
})

test('wavedash: unknown or inactive product is refused (nothing granted)', async () => {
  const { signer, r, player } = await wdRig()
  await storeCode(r.svc.wavedashFromClient(player, receipt(signer, { contentIdentifier: 'mystery' }), undefined), 'unknown_product')
  const row = r.api.rows('etc_products').find(x => x.provider === 'wavedash' && x.code === 'coins-250')!
  await r.api.update('etc_products', row.id as number, { active: false })
  await storeCode(r.svc.wavedashFromClient(player, receipt(signer), undefined), 'unknown_product')
  assert.equal((await r.svc.state(player)).coins, 0)
  assert.equal(r.api.rows('etc_purchases').length, 0)
})

test('wavedash: the receipt must belong to the authenticated player and match the user JWT', async () => {
  const { signer, r, player } = await wdRig()
  const stranger = await r.player('somebody-else', 'wavedash')
  await wdCode(r.svc.wavedashFromClient(stranger, receipt(signer), undefined), 'receipt_mismatch')   // receipt of wd-user-1 sent by another player
  const guest = await r.player('g-1', 'guest')
  await wdCode(r.svc.wavedashFromClient(guest, receipt(signer), undefined), 'receipt_mismatch')
  await wdCode(r.svc.wavedashFromClient(player, receipt(signer), userJwt(signer, { sub: 'wd-user-2' })), 'receipt_mismatch')
  await wdCode(r.svc.wavedashFromClient(player, receipt(signer), userJwt(signer, { gcid: 'other-cloud' })), 'receipt_mismatch')
  await wdCode(r.svc.wavedashFromClient(player, receipt(signer), 'bad.user.jwt'), 'bad_user_jwt')
  assert.equal((await r.svc.state(player)).coins, 0)
  assert.equal((await r.svc.state(stranger)).coins, 0)
})

test('wavedash: without a Wavedash verifier the economy path is closed', async () => {
  const r = await rig()
  const p = await r.player('a')
  await assert.rejects(r.svc.wavedashFromClient(p, 'x.y.z', undefined), /not configured/)
})

// --- webhook ----------------------------------------------------------------------------------------------

function routes(r: Awaited<ReturnType<typeof rig>>) {
  const list = economyRoutes({ backends: () => [{ game: 'g', store: r.store, queues: () => ['quick'], economy: r.svc }] })
  const get = (path: string) => list.find(x => x.path === path)!
  return {
    wavedash: (receiptJwt: unknown) => get('/webhooks/wavedash').handle({ body: JSON.stringify({ receiptJwt }), headers: {} }),
    stripe: (body: string, sig?: string) => get('/webhooks/stripe').handle({ body, headers: sig === undefined ? {} : { 'stripe-signature': sig } }),
  }
}

test('webhook: credits the buyer by receipt sub, fulfills, and a second delivery changes nothing', async () => {
  const { signer, r, calls } = await wdRig()
  const hook = routes(r)
  const rc = receipt(signer, { sub: 'wd-new-buyer', purchaseId: 'pw1' })
  assert.equal((await hook.wavedash(rc)).status, 200)
  assert.equal((await hook.wavedash(rc)).status, 200)
  const buyer = (await r.store.getOrCreateByIdentity({ provider: 'wavedash', external_id: 'wd-new-buyer' })).player.player_id
  assert.equal((await r.svc.state(buyer)).coins, 250)
  const fulfills = calls.filter(c => c.url.endsWith('/api/purchases/pw1/fulfill'))
  assert.ok(fulfills.length >= 1)
  assert.deepEqual(fulfills[0]!.body, { receiptJwt: rc })
})

test('webhook then client with the same receipt: one grant', async () => {
  const { signer, r, player } = await wdRig()
  const hook = routes(r)
  const rc = receipt(signer)
  await hook.wavedash(rc)
  const viaClient = await r.svc.wavedashFromClient(player, rc, undefined)
  assert.equal(viaClient.applied, false)
  assert.equal((await r.svc.state(player)).coins, 250)
})

test('webhook: concurrent deliveries of the same purchase grant once', async () => {
  const { signer, r, player } = await wdRig()
  const hook = routes(r)
  const rc = receipt(signer)
  const out = await Promise.all([...Array.from({ length: 10 }, () => hook.wavedash(rc)), r.svc.wavedashFromClient(player, rc, undefined).then(() => ({ status: 200 }))])
  assert.ok(out.every(x => x.status === 200))
  assert.equal((await r.svc.state(player)).coins, 250)
  assert.equal(r.api.rows('etc_purchases').length, 1)
})

test('webhook: bad receipts are refused, a missing product is retried (409), fulfill failure is retried (502)', async () => {
  const { signer, r } = await wdRig({ fulfill: () => ({ status: 500, body: {} }) })
  const hook = routes(r)
  assert.equal((await hook.wavedash('garbage')).status, 400)
  assert.equal((await hook.wavedash(undefined)).status, 400)
  assert.equal((await hook.wavedash(receipt(newSigner(), { purchaseId: 'x' }))).status, 400)          // unknown signer
  assert.equal((await hook.wavedash(receipt(signer, { aud: 'unknown-game' }))).status, 400)
  assert.equal((await hook.wavedash(receipt(signer, { contentIdentifier: 'mystery', purchaseId: 'x2' }))).status, 409)
  assert.equal((await hook.wavedash(receipt(signer, { purchaseId: 'x3' }))).status, 502)               // granted, Wavedash will retry the fulfill
  const buyer = (await r.store.getOrCreateByIdentity({ provider: 'wavedash', external_id: 'wd-user-1' })).player.player_id
  assert.equal((await r.svc.state(buyer)).coins, 250)
  assert.equal((await hook.wavedash(receipt(signer, { purchaseId: 'x3' }))).status, 502)
  assert.equal((await r.svc.state(buyer)).coins, 250)                                                   // the retry does not grant again
})

test('refund: coins and closed packs are taken back, opened cards are kept; the purchase is marked', async () => {
  const { signer, r, player } = await wdRig()
  const hook = routes(r)
  await hook.wavedash(receipt(signer, { purchaseId: 'b1', contentIdentifier: 'bundle' }))   // 100 coins + 2 packs
  const opened = await r.svc.open(player, 'o1', 'shop')
  assert.equal((await hook.wavedash(receipt(signer, { purchaseId: 'b1', contentIdentifier: 'bundle', event: 'purchase.refunded' }))).status, 200)
  const s = await r.svc.state(player)
  assert.equal(s.coins, opened.result.refund)   // the 100 coins are gone; only the duplicate refund of the opened pack remains
  assert.deepEqual(s.packs, [])   // the second, still closed, pack was taken back
  assert.ok(Object.keys(s.cards).length > 0)
  assert.equal(r.api.rows('etc_purchases')[0]!.status, 'refunded')
  // delivering the refund twice, or the completed event again after it, changes nothing
  await hook.wavedash(receipt(signer, { purchaseId: 'b1', contentIdentifier: 'bundle', event: 'purchase.refunded' }))
  const late = await hook.wavedash(receipt(signer, { purchaseId: 'b1', contentIdentifier: 'bundle' }))
  assert.equal(late.status, 200)
  assert.deepEqual((await r.svc.state(player)).packs, [])
})

test('refund coins may leave a negative balance that blocks spending until repaid', async () => {
  const { signer, r, player } = await wdRig()
  const hook = routes(r)
  await hook.wavedash(receipt(signer, { purchaseId: 'c1' }))                    // +250
  await r.svc.buy(player, 'b1', 'pack-shop', 1)                                 // -100 -> 150
  await r.svc.buy(player, 'b2', 'pack-shop', 1)                                 // -100 -> 50
  await hook.wavedash(receipt(signer, { purchaseId: 'c1', event: 'purchase.refunded' }))
  assert.equal((await r.svc.state(player)).coins, -200)
  await storeCode(r.svc.buy(player, 'b3', 'pack-shop', 1), 'insufficient_funds')
})

test('refund arriving BEFORE the completed event: the later grant is refused', async () => {
  const { signer, r } = await wdRig()
  const hook = routes(r)
  await hook.wavedash(receipt(signer, { purchaseId: 'early', event: 'purchase.refunded' }))
  assert.equal(r.api.rows('etc_purchases')[0]!.status, 'refunded')
  assert.equal((await hook.wavedash(receipt(signer, { purchaseId: 'early' }))).status, 200)   // acknowledged, ignored
  const buyer = (await r.store.getOrCreateByIdentity({ provider: 'wavedash', external_id: 'wd-user-1' })).player.player_id
  assert.equal((await r.svc.state(buyer)).coins, 0)
  await storeCode(r.svc.wavedashFromClient(buyer, receipt(signer, { purchaseId: 'early' }), undefined), 'purchase_refunded')
})

// --- Stripe ---------------------------------------------------------------------------------------------------

function fakeBridge(valid: (raw: string, sig: string) => boolean = (_r, sig) => sig === 'good') {
  const created: Record<string, unknown>[] = []
  const bridge: StripeBridge = {
    async checkout(req) {
      created.push(req)
      const id = `cs_test_${created.length}`
      return { url: `https://checkout.stripe.test/${id}`, session_id: id }
    },
    async verify(raw, sig) {
      if (!valid(raw, sig)) return null
      return JSON.parse(raw) as Record<string, unknown>
    },
  }
  return { bridge, created }
}

const session = (over: Record<string, unknown> = {}) => ({
  id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 200, currency: 'eur',
  metadata: { game: 'g', player_id: '', product: 'coins-250' }, ...over,
})
const event = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } })

test('stripe checkout: a session is opened for an active stripe product and recorded pending', async () => {
  const { bridge, created } = fakeBridge()
  const r = await rig({ stripe: bridge })
  const p = await r.player('a')
  const out = await r.svc.stripeCheckout(p, 'coins-250', 'https://game.example/play')
  assert.match(out.url, /^https:\/\/checkout\.stripe\.test\//)
  assert.equal(created[0]!.product_code, 'coins-250')
  assert.equal(created[0]!.game, 'g')
  assert.match(String(created[0]!.success_url), /checkout=success&session_id=\{CHECKOUT_SESSION_ID\}$/)
  assert.deepEqual(r.api.rows('etc_purchases').map(x => [x.provider, x.status, x.amount, x.currency]), [['stripe', 'pending', 200, 'EUR']])
  await storeCode(r.svc.stripeCheckout(p, 'pack-shop', 'https://game.example/play'), 'unknown_product')   // a coin product is not a stripe product
  assert.equal((await r.svc.state(p)).coins, 0)   // nothing credited before the payment is confirmed
})

test('stripe webhook: signature required; paid session credits once even if the event is delivered many times', async () => {
  const { bridge } = fakeBridge()
  const r = await rig({ stripe: bridge })
  const p = await r.player('a')
  const s = await r.svc.stripeCheckout(p, 'coins-250', 'https://game.example/play')
  const hook = routes(r)
  const body = event('checkout.session.completed', session({ id: s.session_id, metadata: { game: 'g', player_id: p, product: 'coins-250' } }))
  assert.equal((await hook.stripe(body)).status, 400)                  // no signature header
  assert.equal((await hook.stripe(body, 'forged')).status, 400)        // bridge says invalid
  assert.equal((await r.svc.state(p)).coins, 0)
  const results = await Promise.all(Array.from({ length: 8 }, () => hook.stripe(body, 'good')))
  assert.ok(results.every(x => x.status === 200))
  assert.equal((await r.svc.state(p)).coins, 250)
  assert.equal((await hook.stripe(event('checkout.session.async_payment_succeeded', session({ id: s.session_id })), 'good')).status, 200)
  assert.equal((await r.svc.state(p)).coins, 250)
  const row = r.api.rows('etc_purchases')[0]!
  assert.deepEqual([row.status, row.payment_ref], ['granted', 'pi_1'])
})

test('stripe webhook: unpaid sessions, amount mismatches and unknown games grant nothing', async () => {
  const { bridge } = fakeBridge()
  const r = await rig({ stripe: bridge })
  const p = await r.player('a')
  const s = await r.svc.stripeCheckout(p, 'coins-250', 'https://game.example/play')
  const hook = routes(r)
  const meta = { game: 'g', player_id: p, product: 'coins-250' }
  assert.equal((await hook.stripe(event('checkout.session.completed', session({ id: s.session_id, payment_status: 'unpaid', metadata: meta })), 'good')).status, 200)
  assert.equal((await hook.stripe(event('checkout.session.completed', session({ id: s.session_id, amount_total: 1, metadata: meta })), 'good')).status, 200)
  assert.equal((await hook.stripe(event('checkout.session.completed', session({ id: s.session_id, currency: 'usd', metadata: meta })), 'good')).status, 200)
  assert.equal((await hook.stripe(event('checkout.session.completed', session({ id: 'cs_other', metadata: { ...meta, game: 'elsewhere' } })), 'good')).status, 200)
  assert.equal((await hook.stripe(event('payment_intent.created', {}), 'good')).status, 200)
  assert.equal((await r.svc.state(p)).coins, 0)
  assert.ok(r.logs.some(l => l.includes('does not match')))
})

test('stripe webhook: a paid session whose pending row was lost is recovered from its metadata', async () => {
  const { bridge } = fakeBridge()
  const r = await rig({ stripe: bridge })
  const p = await r.player('a')
  const hook = routes(r)
  const body = event('checkout.session.completed', session({ id: 'cs_lost', metadata: { game: 'g', player_id: p, product: 'coins-250' } }))
  assert.equal((await hook.stripe(body, 'good')).status, 200)
  assert.equal((await r.svc.state(p)).coins, 250)
  assert.equal((await hook.stripe(event('checkout.session.completed', session({ id: 'cs_ghost', metadata: { game: 'g', player_id: 'nobody', product: 'coins-250' } })), 'good')).status, 200)
})

test('stripe refund: reverses the grant once; partial refunds and foreign charges are ignored', async () => {
  const { bridge } = fakeBridge()
  const r = await rig({ stripe: bridge })
  const p = await r.player('a')
  const s = await r.svc.stripeCheckout(p, 'coins-250', 'https://game.example/play')
  const hook = routes(r)
  await hook.stripe(event('checkout.session.completed', session({ id: s.session_id, metadata: { game: 'g', player_id: p, product: 'coins-250' } })), 'good')
  assert.equal((await hook.stripe(event('charge.refunded', { payment_intent: 'pi_1', amount: 200, amount_refunded: 50, refunded: false }), 'good')).status, 200)
  assert.equal((await r.svc.state(p)).coins, 250)
  assert.equal((await hook.stripe(event('charge.refunded', { payment_intent: 'pi_other', amount: 200, amount_refunded: 200, refunded: true }), 'good')).status, 200)
  assert.equal((await r.svc.state(p)).coins, 250)
  const full = event('charge.refunded', { payment_intent: 'pi_1', amount: 200, amount_refunded: 200, refunded: true })
  await hook.stripe(full, 'good'); await hook.stripe(full, 'good')
  assert.equal((await r.svc.state(p)).coins, 0)
  assert.equal(r.api.rows('etc_purchases')[0]!.status, 'refunded')
  // a late duplicate of the completed event does not grant a refunded purchase
  await hook.stripe(event('checkout.session.completed', session({ id: s.session_id, metadata: { game: 'g', player_id: p, product: 'coins-250' } })), 'good')
  assert.equal((await r.svc.state(p)).coins, 0)
})

test('stripe webhook: a bridge outage is retried (503), never silently dropped', async () => {
  const bridge: StripeBridge = { checkout: async () => { throw new Error('x') }, verify: async () => { throw new Error('down') } }
  const r = await rig({ stripe: bridge })
  assert.equal((await routes(r).stripe('{}', 'good')).status, 503)
  const none = await rig()
  assert.equal((await routes(none).stripe('{}', 'good')).status, 503)
})

test('tenantWith(): helper sanity (products and publishers exist)', async () => {
  const api = await tenantWith()
  assert.equal(api.rows('etc_products').length, 5)
})
