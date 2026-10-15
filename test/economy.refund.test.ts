import test from 'node:test'
import assert from 'node:assert/strict'
import { StoreError } from '../src/store/errors.ts'
import type { StripeBridge } from '../src/economy/stripe.ts'
import { fakeWavedash, newSigner, NOW_MS, receipt, rig } from './economy.helpers.ts'
import { economyRoutes } from '../src/economy/routes.ts'

const DAY = 86_400_000
const storeCode = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: unknown) => e instanceof StoreError && e.code === c)
const bridge: StripeBridge = {
  async checkout(req) { return { url: `https://checkout.stripe.test/${req.product_code}`, session_id: 'cs_1' } },
  async verify() { return null },
}

async function setup(opts: { days?: string } = {}) {
  const signer = newSigner()
  const fw = fakeWavedash([signer])
  const r = await rig({ wavedash: fw.wd, stripe: bridge, now: () => NOW_MS })
  if (opts.days !== undefined) await r.api.insert('etc_settings', { key: 'economy.refund_ban_days', value: opts.days })
  const player = await r.player('wd-user-1', 'wavedash')
  const wd = economyRoutes({ backends: () => [{ game: 'g', economy: r.svc } as never] })[0]!
  const send = (rc: string) => wd.handle({ body: JSON.stringify({ receiptJwt: rc }), headers: {} })
  return { signer, r, player, send }
}

test('refund bans real-money purchases for 30 days by default: checkout refused, only coin products listed', async () => {
  const { signer, r, player, send } = await setup()
  await send(receipt(signer, { purchaseId: 'p1' }))
  assert.equal(await r.svc.purchaseBlockedUntil(player), null)
  assert.ok((await r.svc.products(player)).some(p => p.provider === 'stripe'))
  await send(receipt(signer, { purchaseId: 'p1', event: 'purchase.refunded' }))
  assert.equal(await r.svc.purchaseBlockedUntil(player), NOW_MS + 30 * DAY)
  await storeCode(r.svc.stripeCheckout(player, 'coins-250', 'https://game.example/'), 'purchases_blocked')
  const shown = await r.svc.products(player)
  assert.ok(shown.length > 0 && shown.every(p => p.provider === 'coins'))      // coin shop stays open
  assert.ok((await r.svc.products()).some(p => p.provider === 'stripe'))        // anonymous listing unchanged
  assert.equal(r.api.rows('etc_purchase_bans').length, 1)
  // the same refund delivered again does not stack a second ban
  await send(receipt(signer, { purchaseId: 'p1', event: 'purchase.refunded' }))
  assert.equal(r.api.rows('etc_purchase_bans').length, 1)
})

test('the ban length is a setting; 0 disables it', async () => {
  const a = await setup({ days: '7' })
  await a.send(receipt(a.signer, { purchaseId: 'p1' }))
  await a.send(receipt(a.signer, { purchaseId: 'p1', event: 'purchase.refunded' }))
  assert.equal(await a.r.svc.purchaseBlockedUntil(a.player), NOW_MS + 7 * DAY)
  const b = await setup({ days: '0' })
  await b.send(receipt(b.signer, { purchaseId: 'p1' }))
  await b.send(receipt(b.signer, { purchaseId: 'p1', event: 'purchase.refunded' }))
  assert.equal(await b.r.svc.purchaseBlockedUntil(b.player), null)
})

test('a purchase already paid during the ban is still granted (we never keep money without goods)', async () => {
  const { signer, r, player, send } = await setup()
  await send(receipt(signer, { purchaseId: 'p1' }))
  await send(receipt(signer, { purchaseId: 'p1', event: 'purchase.refunded' }))
  assert.equal((await send(receipt(signer, { purchaseId: 'p2' }))).status, 200)
  assert.equal((await r.svc.state(player)).coins, 250)
})

test('refund claws back spent value: later pack purchases, then the cards of the newest openings', async () => {
  const { signer, r, player, send } = await setup()
  await send(receipt(signer, { purchaseId: 'p1' }))                 // +250 coins
  for (let i = 0; i < 2; i++) await r.svc.buy(player, `b${i}`, 'pack-shop', 1)   // 2 packs for 200 -> 50 left
  const a = await r.svc.open(player, 'o1', 'shop')
  const b = await r.svc.open(player, 'o2', 'shop')
  const cardsBefore = Object.keys((await r.svc.state(player)).cards).length
  assert.ok(cardsBefore > 0 && a.result.cards.length > 0 && b.result.cards.length > 0)
  await send(receipt(signer, { purchaseId: 'p1', event: 'purchase.refunded' }))
  const s = await r.svc.state(player)
  assert.equal(s.coins, 0)
  assert.deepEqual(s.packs, [])
  assert.deepEqual(s.cards, {})      // both packs came from the refunded coins: everything goes
})

test('cards from rewards or earlier purchases are kept', async () => {
  const { signer, r, player, send } = await setup()
  await send(receipt(signer, { purchaseId: 'old' }))                // earlier, never refunded: +250
  await r.svc.buy(player, 'b0', 'pack-shop', 1)
  const keep = await r.svc.open(player, 'o0', 'shop')
  await send(receipt(signer, { purchaseId: 'new' }))                // the purchase that will be refunded: +250
  await r.svc.buy(player, 'b1', 'pack-shop', 1)
  await r.svc.open(player, 'o1', 'shop')
  await send(receipt(signer, { purchaseId: 'new', event: 'purchase.refunded' }))
  const s = await r.svc.state(player)
  for (const c of keep.result.cards) assert.ok((s.cards[c.id] ?? 0) >= 1, `kept ${c.id}`)
})
