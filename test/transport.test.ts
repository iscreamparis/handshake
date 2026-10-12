import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { loadConfig } from '../src/config.ts'
import type { ClientConn } from '../src/hub.ts'
import { startTransport } from '../src/transport.ts'
import type { Endpoint, UpgradeInfo } from '../src/transport.ts'

let WsClient: any = null
try {
  WsClient = (await import('ws')).WebSocket
} catch {
  WsClient = null
}
const skip = WsClient === null ? 'ws not installed' : false
const testOptions = { skip, timeout: 5000 }

function config(allowedOrigins: string[] = []) {
  return { ...loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error' }), allowedOrigins }
}

function fakeEndpoint(path: string, claims?: (frame: string) => boolean) {
  const opened: { conn: ClientConn; info: UpgradeInfo; frames: string[] }[] = []
  const frames: string[] = []
  const closed: ClientConn[] = []
  const ticks: number[] = []
  const endpoint: Endpoint = {
    path, maxPayload: 65536, heartbeatMs: null, claims,
    open(conn, info) {
      const record = { conn, info, frames: [] as string[] }
      opened.push(record)
      return {
        message(frame) {
          record.frames.push(frame)
          frames.push(frame)
          conn.send(frame)
        },
        closed() { closed.push(conn) },
      }
    },
    tick(nowMs) { ticks.push(nowMs) },
  }
  return { endpoint, opened, frames, closed, ticks }
}

function httpGet(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }))
    })
    req.on('error', reject)
  })
}

function upgradeStatus(port: number, path: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port })
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => socket.destroy(new Error('upgrade timed out')))
    socket.on('error', reject)
    socket.on('data', (chunk: string) => { response += chunk })
    socket.on('end', () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)
      if (status) resolve(Number(status[1]))
      else reject(new Error(`Missing upgrade status: ${response}`))
    })
    socket.on('connect', () => socket.write([
      `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ...(origin ? [`Origin: ${origin}`] : []), '', '',
    ].join('\r\n')))
  })
}

async function connect(port: number, path: string, origin?: string) {
  const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, { origin })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }))
  })
  ws.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, closed }
}

async function sendFrame(client: Awaited<ReturnType<typeof connect>>, frame: string) {
  const echoed = new Promise<string>((resolve) => {
    client.ws.once('message', (data: Buffer) => resolve(data.toString()))
  })
  client.ws.send(frame)
  assert.equal(await echoed, frame)
}

test('unknown upgrade paths and disallowed origins get 403; allowed origins open', testOptions, async () => {
  const fake = fakeEndpoint('/ws')
  const transport = await startTransport({ cfg: config(['https://ok.example']), endpoints: [fake.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    assert.equal(await upgradeStatus(transport.port, '/unknown', 'https://ok.example'), 403)
    assert.equal(await upgradeStatus(transport.port, '/ws', 'https://bad.example'), 403)
    assert.equal(fake.opened.length, 0)
    const client = await connect(transport.port, '/ws', 'https://ok.example')
    assert.equal(fake.opened.length, 1)
    assert.equal(fake.opened[0].info.headers.origin, 'https://ok.example')
    await sendFrame(client, 'allowed')
  } finally {
    await transport.close()
  }
  assert.deepEqual(fake.closed, fake.opened.map(({ conn }) => conn))
})

test('distinct paths isolate frames and serve health and HTTP 404', testOptions, async () => {
  const a = fakeEndpoint('/a')
  const b = fakeEndpoint('/b')
  const health = { ok: true, rooms: 3, clients: 2, version: 'test' }
  const transport = await startTransport({ cfg: config(), endpoints: [a.endpoint, b.endpoint], health: () => health, log: () => {}, autoTick: false })
  try {
    const ca = await connect(transport.port, '/a?client=a')
    const cb = await connect(transport.port, '/b')
    await sendFrame(ca, 'a-first')
    await sendFrame(cb, 'b-only')
    await sendFrame(ca, 'a-second')
    assert.deepEqual(a.frames, ['a-first', 'a-second'])
    assert.deepEqual(b.frames, ['b-only'])
    assert.equal(a.opened.length, 1)
    assert.equal(b.opened.length, 1)
    assert.equal(a.opened[0].info.url, '/a?client=a')
    const res = await httpGet(transport.port, '/health')
    assert.equal(res.status, 200)
    assert.equal(res.type, 'application/json')
    assert.deepEqual(JSON.parse(res.body), health)
    const missing = await httpGet(transport.port, '/other')
    assert.equal(missing.status, 404)
    assert.equal(missing.type, 'text/plain')
    assert.equal(missing.body, 'not found')
  } finally {
    await transport.close()
  }
  assert.deepEqual(a.closed, [a.opened[0].conn])
  assert.deepEqual(b.closed, [b.opened[0].conn])
})

test('shared paths defer open and keep the endpoint selected by the first frame', testOptions, async () => {
  const rooms = fakeEndpoint('/ws')
  const relay = fakeEndpoint('/ws', (frame) => frame.includes('"relay"'))
  const transport = await startTransport({ cfg: config(), endpoints: [rooms.endpoint, relay.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    const claimed = await connect(transport.port, '/ws')
    const defaulted = await connect(transport.port, '/ws')
    assert.equal(rooms.opened.length, 0)
    assert.equal(relay.opened.length, 0)
    const relayHello = '{"t":"relay"}'
    const roomsHello = '{"t":"hello","v":1,"game":"kart-test","name":"Ann"}'
    await sendFrame(claimed, relayHello)
    await sendFrame(claimed, roomsHello)
    assert.equal(rooms.opened.length, 0)
    assert.equal(relay.opened.length, 1)
    await sendFrame(defaulted, roomsHello)
    await sendFrame(defaulted, relayHello)
    assert.equal(rooms.opened.length, 1)
    assert.equal(relay.opened.length, 1)
    assert.deepEqual(relay.frames, [relayHello, roomsHello])
    assert.deepEqual(rooms.frames, [roomsHello, relayHello])
    assert.deepEqual(relay.opened[0].frames, relay.frames)
    assert.deepEqual(rooms.opened[0].frames, rooms.frames)
  } finally {
    await transport.close()
  }
  assert.deepEqual(rooms.closed, [rooms.opened[0].conn])
  assert.deepEqual(relay.closed, [relay.opened[0].conn])
})

test('shared-path pending connections survive 5000ms and time out after 10000ms', testOptions, async () => {
  const rooms = fakeEndpoint('/ws')
  const relay = fakeEndpoint('/ws', (frame) => frame.includes('"relay"'))
  const transport = await startTransport({ cfg: config(), endpoints: [rooms.endpoint, relay.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    const client = await connect(transport.port, '/ws')
    const now = Date.now()
    transport.tick(now + 5000)
    // A pong confirms the socket is still usable without sending a first text frame.
    const pong = new Promise<void>((resolve) => client.ws.once('pong', resolve))
    client.ws.ping()
    await pong
    assert.equal(client.ws.readyState, 1)
    assert.equal(rooms.opened.length, 0)
    assert.equal(relay.opened.length, 0)
    transport.tick(now + 10001)
    assert.deepEqual(await client.closed, { code: 4000, reason: 'hello_timeout' })
    assert.deepEqual(rooms.frames, [])
    assert.deepEqual(relay.frames, [])
    assert.deepEqual(rooms.closed, [])
    assert.deepEqual(relay.closed, [])
  } finally {
    await transport.close()
  }
})

test('tick forwards the supplied time to every endpoint', testOptions, async () => {
  const a = fakeEndpoint('/a')
  const b = fakeEndpoint('/b')
  const transport = await startTransport({ cfg: config(), endpoints: [a.endpoint, b.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    assert.deepEqual(a.ticks, [])
    assert.deepEqual(b.ticks, [])
    transport.tick(123456789)
    transport.tick(123457789)
    assert.deepEqual(a.ticks, [123456789, 123457789])
    assert.deepEqual(b.ticks, [123456789, 123457789])
  } finally {
    await transport.close()
  }
})

test('close resolves when called twice with an open connection', testOptions, async () => {
  const fake = fakeEndpoint('/ws')
  const transport = await startTransport({ cfg: config(), endpoints: [fake.endpoint], health: () => ({}), log: () => {}, autoTick: false })
  try {
    const client = await connect(transport.port, '/ws')
    await transport.close()
    await transport.close()
    assert.deepEqual(await client.closed, { code: 1001, reason: 'server shutdown' })
    assert.deepEqual(fake.closed, [fake.opened[0].conn])
  } finally {
    await transport.close()
  }
})
