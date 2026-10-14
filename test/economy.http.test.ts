import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.ts'
import { startTransport } from '../src/transport.ts'
import type { HttpRoute } from '../src/transport.ts'
import { createHandshake } from '../src/handshake.ts'
import { economyRoutes } from '../src/economy/routes.ts'
import { fakeWavedash, newSigner, NOW_MS, receipt, rig } from './economy.helpers.ts'

const cfg = () => loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error' })

test('http routes: POST body reaches the handler, size is capped, other methods and paths 404', async () => {
  const seen: string[] = []
  const route: HttpRoute = {
    method: 'POST', path: '/webhooks/x', maxBytes: 100,
    async handle({ body, headers }) { seen.push(`${body}|${String(headers['x-test'])}`); return { status: 202, body: { got: body.length } } },
  }
  const t = await startTransport({ cfg: cfg(), endpoints: [], health: () => ({ ok: true }), log: () => {}, http: [route] })
  try {
    const base = `http://127.0.0.1:${t.port}`
    const ok = await fetch(`${base}/webhooks/x`, { method: 'POST', body: 'hello', headers: { 'x-test': 'yes' } })
    assert.equal(ok.status, 202)
    assert.deepEqual(await ok.json(), { got: 5 })
    assert.deepEqual(seen, ['hello|yes'])
    assert.equal((await fetch(`${base}/webhooks/x`, { method: 'POST', body: 'x'.repeat(500) }).catch(() => ({ status: 413 }))).status, 413)
    assert.equal((await fetch(`${base}/webhooks/x`)).status, 404)
    assert.equal((await fetch(`${base}/webhooks/y`, { method: 'POST', body: '{}' })).status, 404)
    assert.equal((await fetch(`${base}/health`)).status, 200)
  } finally {
    await t.close()
  }
})

test('a handler that throws answers 500 without leaking the error', async () => {
  const route: HttpRoute = { method: 'POST', path: '/boom', async handle() { throw new Error('secret detail') } }
  const t = await startTransport({ cfg: cfg(), endpoints: [], health: () => ({ ok: true }), log: () => {}, http: [route] })
  try {
    const res = await fetch(`http://127.0.0.1:${t.port}/boom`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 500)
    assert.ok(!(await res.text()).includes('secret'))
  } finally {
    await t.close()
  }
})

test('createHandshake serves the Wavedash webhook end to end over real HTTP', async () => {
  const signer = newSigner()
  const fw = fakeWavedash([signer])
  const r = await rig({ wavedash: fw.wd, now: () => NOW_MS })
  const hs = createHandshake({
    config: { port: 0, host: '127.0.0.1', logLevel: 'error' }, autoTick: false,
    store: { resolve: () => ({ game: 'g', store: r.store, queues: () => ['quick'], economy: r.svc }) },
    http: economyRoutes({ backends: () => [{ game: 'g', store: r.store, queues: () => ['quick'], economy: r.svc }] }),
  })
  const { port } = await hs.listen()
  try {
    const body = JSON.stringify({ receiptJwt: receipt(signer, { sub: 'http-buyer', purchaseId: 'h1' }) })
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/wavedash`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 200)
    const again = await fetch(`http://127.0.0.1:${port}/webhooks/wavedash`, { method: 'POST', body })
    assert.equal(again.status, 200)
    const buyer = (await r.store.getOrCreateByIdentity({ provider: 'wavedash', external_id: 'http-buyer' })).player.player_id
    assert.equal((await r.svc.state(buyer)).coins, 250)
    assert.equal((await fetch(`http://127.0.0.1:${port}/webhooks/wavedash`, { method: 'POST', body: '{"receiptJwt":"nope"}' })).status, 400)
  } finally {
    await hs.close()
  }
})
