import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { createHandshake, createMemoryStore } from '../src/index.ts'

type Msg = Record<string, any>

let WsClient: any = null
try {
  WsClient = (await import('ws')).WebSocket
} catch {
  WsClient = null
}
const skip = WsClient === null ? 'ws not installed' : false

const PLAYER = { name: 'Ann', build: { characterId: 'sprout', bodyId: 'std', wheelId: 'std', gliderId: 'std' } }

function make() {
  return createHandshake({ config: { port: 0, host: '127.0.0.1', logLevel: 'error' }, store: createMemoryStore() })
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}

interface Client { ws: any; next(t: string): Promise<Msg>; closed: Promise<void> }

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
  const closed = new Promise<void>((resolve) => { ws.on('close', () => resolve()) })
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

test('rooms flow: hello, create, join, signal', { skip }, async () => {
  const hs = make()
  try {
    const { port } = await hs.listen()
    const a = await connect(port)
    const b = await connect(port)
    const w = await hello(a, 'Ann')
    assert.equal(w.v, 1)
    await hello(b, 'Bob')
    send(a, { t: 'create', players: [PLAYER], rid: 1 })
    const created = await a.next('room')
    send(b, { t: 'join', code: created.code, players: [{ ...PLAYER, name: 'Bob' }] })
    const joined = await b.next('room')
    assert.equal(joined.you, 1)
    send(a, { t: 'signal', to: 1, data: { kind: 'offer', sdp: 'v=0' } })
    const sig = await b.next('signal')
    assert.equal(sig.from, 0)
    assert.deepEqual(sig.data, { kind: 'offer', sdp: 'v=0' })
    a.ws.close()
    b.ws.close()
    await Promise.all([a.closed, b.closed])
  } finally {
    await hs.close()
  }
})

test('GET /health has exactly ok, rooms, clients, version', { skip }, async () => {
  const hs = make()
  try {
    const { port } = await hs.listen()
    const res = await httpGet(port, '/health')
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body) as Msg
    assert.deepEqual(Object.keys(body).sort(), ['clients', 'ok', 'rooms', 'version'])
  } finally {
    await hs.close()
  }
})

test('a second listen() rejects', async () => {
  const hs = make()
  try {
    await hs.listen()
    await assert.rejects(hs.listen())
  } finally {
    await hs.close()
  }
})

test('close() twice resolves; close() before listen resolves', async () => {
  const hs = make()
  await hs.listen()
  await hs.close()
  await hs.close()
  await make().close()
})

test('port is 0 before listen and the listen() result after', async () => {
  const hs = make()
  try {
    assert.equal(hs.port, 0)
    const { port } = await hs.listen()
    assert.ok(port > 0)
    assert.equal(hs.port, port)
  } finally {
    await hs.close()
  }
})
