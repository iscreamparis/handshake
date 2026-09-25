import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { loadConfig } from '../src/config.ts'
import { startServer } from '../src/server.ts'

type Msg = Record<string, any>

let WsClient: any = null
try {
  WsClient = (await import('ws')).WebSocket
} catch {
  WsClient = null
}
const skip = WsClient === null ? 'ws not installed' : false

const PLAYER = { name: 'Ann', build: { characterId: 'sprout', bodyId: 'std', wheelId: 'std', gliderId: 'std' } }

// node:http directly (not fetch) so an HTTP proxy in the environment is never used.
function httpGet(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }))
    })
    req.on('error', reject)
  })
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error' })
  const srv = await startServer(cfg)
  try {
    await fn(srv.port)
  } finally {
    await srv.close()
  }
}

interface Client { ws: any; next(t: string): Promise<Msg>; closed: Promise<{ code: number; reason: string }> }

async function connect(port: number): Promise<Client> {
  const ws = new WsClient(`ws://127.0.0.1:${port}/ws`)
  const queue: Msg[] = []
  const waiters: { t: string; resolve: (m: Msg) => void }[] = []
  ws.on('message', (data: Buffer) => {
    const m = JSON.parse(data.toString()) as Msg
    const i = waiters.findIndex((w) => w.t === m.t)
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
    else queue.push(m)
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }))
  })
  ws.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  function next(t: string): Promise<Msg> {
    const i = queue.findIndex((m) => m.t === t)
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
    return new Promise((resolve) => waiters.push({ t, resolve }))
  }
  return { ws, next, closed }
}

function send(c: Client, m: Msg): void {
  c.ws.send(JSON.stringify(m))
}

async function hello(c: Client, name: string): Promise<Msg> {
  send(c, { t: 'hello', v: 1, game: 'kart-test', name })
  return c.next('welcome')
}

test('/health returns 200 with ok true', { skip }, async () => {
  await withServer(async (port) => {
    const res = await httpGet(port, '/health')
    assert.equal(res.status, 200)
    assert.match(res.type, /application\/json/)
    const body = JSON.parse(res.body) as Msg
    assert.equal(body.ok, true)
    assert.equal(body.rooms, 0)
    assert.equal(body.clients, 0)
    assert.equal(typeof body.version, 'string')
  })
})

test('/nope returns 404', { skip }, async () => {
  await withServer(async (port) => {
    const res = await httpGet(port, '/nope')
    assert.equal(res.status, 404)
  })
})

test('ws client to /ws sends hello and gets welcome', { skip }, async () => {
  await withServer(async (port) => {
    const c = await connect(port)
    const w = await hello(c, 'Ann')
    assert.equal(w.v, 1)
    assert.equal(typeof w.client, 'string')
    assert.ok(Array.isArray(w.iceServers))
    assert.equal(w.maxHumans, 8)
    assert.equal(w.maxLocal, 4)
    c.ws.close()
    await c.closed
  })
})

test('two clients create, join and relay a signal offer', { skip }, async () => {
  await withServer(async (port) => {
    const a = await connect(port)
    const b = await connect(port)
    await hello(a, 'Ann')
    await hello(b, 'Bob')
    send(a, { t: 'create', players: [PLAYER], rid: 1 })
    const created = await a.next('room')
    assert.equal(created.you, 0)
    assert.equal(created.owner, 0)
    send(b, { t: 'join', code: ` ${String(created.code).toLowerCase()} `, players: [{ ...PLAYER, name: 'Bob' }] })
    const joined = await b.next('room')
    assert.equal(joined.you, 1)
    assert.equal((await a.next('room')).members.length, 2)
    send(a, { t: 'signal', to: 1, data: { kind: 'offer', sdp: 'v=0' } })
    const sig = await b.next('signal')
    assert.equal(sig.from, 0)
    assert.deepEqual(sig.data, { kind: 'offer', sdp: 'v=0' })
    a.ws.close()
    b.ws.close()
    await Promise.all([a.closed, b.closed])
  })
})

test('a 70000-byte message closes with 4009', { skip }, async () => {
  await withServer(async (port) => {
    const c = await connect(port)
    await hello(c, 'Ann')
    c.ws.send('x'.repeat(70000))
    const { code } = await c.closed
    assert.equal(code, 4009)
  })
})
