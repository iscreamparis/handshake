import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoomHub } from '../src/hub.ts'
import type { ClientConn } from '../src/hub.ts'
import { loadConfig } from '../src/config.ts'

type Msg = Record<string, any>

class FakeConn implements ClientConn {
  sent: Msg[] = []
  closes: { code: number; reason: string }[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(code: number, reason: string): void { this.closes.push({ code, reason }) }
  last(): Msg { return this.sent[this.sent.length - 1] }
  take(): Msg[] { const out = this.sent; this.sent = []; return out }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const T0 = 1_700_000_000_000
const SEED = 0xdeadbeef

function setup(env: Record<string, string> = {}) {
  const clock = { now: T0 }
  const logs: string[] = []
  const hub = new RoomHub(loadConfig(env), {
    now: () => clock.now,
    random: mulberry32(42),
    seed: () => SEED,
    log: (level, msg) => { logs.push(`${level} ${msg}`) },
  })
  const connect = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn)
    const send = (m: Msg) => hub.message(id, JSON.stringify(m))
    return { conn, id, send }
  }
  const hello = (game = 'kart-1', name = 'Ann') => {
    const c = connect()
    c.send({ t: 'hello', v: 1, game, name })
    assert.equal(c.conn.last().t, 'welcome')
    c.conn.take()
    return c
  }
  return { hub, clock, logs, connect, hello }
}

function players(n: number, prefix = 'P'): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < n; i++) {
    out.push({ name: `${prefix}${i}`, build: { characterId: 'kit', bodyId: 'std', wheelId: 'std', gliderId: 'std' } })
  }
  return out
}

function createRoom(s: ReturnType<typeof setup>, n = 1, game = 'kart-1') {
  const owner = s.hello(game)
  owner.send({ t: 'create', players: players(n) })
  const room = owner.conn.take()[0]
  assert.equal(room.t, 'room')
  return { owner, code: room.code as string }
}

function joiner(s: ReturnType<typeof setup>, code: string, n = 1, game = 'kart-1') {
  const c = s.hello(game)
  c.send({ t: 'join', code, players: players(n) })
  return c
}

test('hello required before anything, and bad version closes with 4001', () => {
  const s = setup()
  const a = s.connect()
  a.send({ t: 'create', players: players(1), rid: 3 })
  assert.deepEqual(a.conn.last(), { t: 'error', rid: 3, code: 'hello_required', message: a.conn.last().message })
  assert.equal(a.conn.closes.length, 0)
  a.send({ t: 'hello', v: 2, game: 'kart-1', name: 'Ann' })
  assert.equal(a.conn.last().code, 'bad_version')
  assert.deepEqual(a.conn.closes, [{ code: 4001, reason: 'bad_version' }])
  assert.equal(s.hub.stats().clients, 0)
  const b = s.connect()
  b.send({ t: 'hello', v: 1, game: 'kart-1', name: 'Bob' })
  const w = b.conn.last()
  assert.equal(w.t, 'welcome')
  assert.equal(w.v, 1)
  assert.equal(w.client, b.id)
  assert.equal(w.maxHumans, 8)
  assert.equal(w.maxLocal, 4)
  assert.deepEqual(w.iceServers, [{ urls: ['stun:stun.l.google.com:19302'] }])
})

test('create gives peer 0 and owner', () => {
  const s = setup()
  const a = s.hello()
  a.send({ t: 'create', players: players(2) })
  const r = a.conn.last()
  assert.equal(r.t, 'room')
  assert.match(r.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/)
  assert.equal(r.you, 0)
  assert.equal(r.owner, 0)
  assert.equal(r.status, 'lobby')
  assert.equal(r.humans, 2)
  assert.deepEqual(r.settings, { kind: 'cup', cupId: 'sprout', trackId: 'meadow-loop', cc: 150, items: true })
  assert.deepEqual(r.members, [{ peer: 0, name: 'Ann', players: players(2) }])
  assert.equal(s.hub.stats().rooms, 1)
  a.send({ t: 'create', players: players(1) })
  assert.equal(a.conn.last().code, 'already_in_room')
})

test('join by a lower-case code with spaces', () => {
  const s = setup()
  const { owner, code } = createRoom(s)
  const b = joiner(s, `  ${code.toLowerCase()} `)
  const r = b.conn.last()
  assert.equal(r.t, 'room')
  assert.equal(r.code, code)
  assert.equal(r.you, 1)
  assert.equal(r.owner, 0)
  assert.equal(r.humans, 2)
  assert.deepEqual(r.members.map((m: Msg) => m.peer), [0, 1])
  const o = owner.conn.last()
  assert.equal(o.t, 'room')
  assert.equal(o.you, 0)
  assert.equal(o.members.length, 2)
  const bad = s.hello()
  bad.send({ t: 'join', code: 'ZZZZ', players: players(1) })
  assert.equal(bad.conn.last().code, 'room_not_found')
})

test('the 9th machine gives room_full, and 9 humans over 3 machines give room_full', () => {
  const s = setup()
  const { code } = createRoom(s)
  for (let i = 1; i < 8; i++) assert.equal(joiner(s, code).conn.last().you, i)
  assert.equal(joiner(s, code).conn.last().code, 'room_full')

  const s2 = setup()
  const r2 = createRoom(s2, 4)
  assert.equal(joiner(s2, r2.code, 4).conn.last().humans, 8)
  const third = joiner(s2, r2.code, 1)
  assert.equal(third.conn.last().code, 'room_full')
  assert.equal(s2.hub.stats().clients, 3)
})

test('game_mismatch when the joiner runs another build', () => {
  const s = setup()
  const { code } = createRoom(s, 1, 'kart-1')
  const b = joiner(s, code, 1, 'kart-2')
  assert.equal(b.conn.last().code, 'game_mismatch')
})

test('settings by a non-owner give not_owner', () => {
  const s = setup()
  const { owner, code } = createRoom(s)
  const b = joiner(s, code)
  owner.conn.take()
  const settings = { kind: 'track', cupId: 'sprout', trackId: 'dune-run', cc: 200, items: false }
  b.send({ t: 'settings', settings, rid: 'x' })
  assert.deepEqual(b.conn.last(), { t: 'error', rid: 'x', code: 'not_owner', message: b.conn.last().message })
  assert.equal(owner.conn.sent.length, 0)
  owner.send({ t: 'settings', settings })
  assert.deepEqual(owner.conn.last().settings, settings)
  assert.deepEqual(b.conn.last().settings, settings)
})

test('start gives every member an identical started (same seed and members)', () => {
  const s = setup()
  const { owner, code } = createRoom(s, 2)
  const b = joiner(s, code, 3)
  const c = joiner(s, code, 1)
  owner.conn.take(); b.conn.take(); c.conn.take()
  b.send({ t: 'start' })
  assert.equal(b.conn.last().code, 'not_owner')
  owner.send({ t: 'start' })
  const msgs = [owner, b, c].map((x) => x.conn.last())
  for (const m of msgs) {
    assert.equal(m.t, 'started')
    assert.equal(m.seed, SEED >>> 0)
    assert.deepEqual(m, msgs[0])
  }
  assert.deepEqual(msgs[0].members.map((m: Msg) => [m.peer, m.players.length]), [[0, 2], [1, 3], [2, 1]])
  owner.send({ t: 'start' })
  assert.equal(owner.conn.last().code, 'room_started')
  owner.send({ t: 'end' })
  assert.equal(owner.conn.last().t, 'room')
  assert.equal(owner.conn.last().status, 'lobby')
  owner.send({ t: 'end' })
  assert.equal(owner.conn.last().code, 'bad_message')
})

test('join while racing gives room_started', () => {
  const s = setup()
  const { owner, code } = createRoom(s)
  owner.send({ t: 'start' })
  const b = joiner(s, code)
  assert.equal(b.conn.last().code, 'room_started')
  owner.send({ t: 'players', players: players(2) })
  assert.equal(owner.conn.last().code, 'room_started')
})

test('signal relay reaches only the target; peer_not_found for self or unknown', () => {
  const s = setup()
  const { owner, code } = createRoom(s)
  const b = joiner(s, code)
  const c = joiner(s, code)
  const other = createRoom(s)
  owner.conn.take(); b.conn.take(); c.conn.take()
  const data = { kind: 'offer', sdp: 'v=0' }
  owner.send({ t: 'signal', to: 2, data })
  assert.deepEqual(c.conn.take(), [{ t: 'signal', from: 0, data }])
  assert.equal(b.conn.sent.length, 0)
  assert.equal(owner.conn.sent.length, 0)
  assert.equal(other.owner.conn.sent.length, 0)
  owner.send({ t: 'signal', to: 0, data })
  assert.equal(owner.conn.last().code, 'peer_not_found')
  owner.send({ t: 'signal', to: 5, data })
  assert.equal(owner.conn.last().code, 'peer_not_found')
  other.owner.send({ t: 'signal', to: 1, data })
  assert.equal(other.owner.conn.last().code, 'peer_not_found')
  assert.equal(b.conn.sent.length, 0)
  assert.equal(c.conn.sent.length, 0)
})

test('owner leave transfers ownership to the lowest peer, with peerLeft then room', () => {
  const s = setup()
  const { owner, code } = createRoom(s)
  const b = joiner(s, code)
  const c = joiner(s, code)
  const d = joiner(s, code)
  b.send({ t: 'leave' })
  assert.deepEqual(b.conn.last(), { t: 'left' })
  owner.conn.take(); c.conn.take(); d.conn.take()
  owner.send({ t: 'leave', rid: 9 })
  assert.deepEqual(owner.conn.last(), { t: 'left', rid: 9 })
  for (const [x, you] of [[c, 2], [d, 3]] as const) {
    const [pl, room] = x.conn.take()
    assert.deepEqual(pl, { t: 'peerLeft', peer: 0 })
    assert.equal(room.t, 'room')
    assert.equal(room.owner, 2)
    assert.equal(room.you, you)
    assert.equal('rid' in room, false)
    assert.deepEqual(room.members.map((m: Msg) => m.peer), [2, 3])
  }
  const e = joiner(s, code)
  assert.equal(e.conn.last().you, 0)
  e.send({ t: 'settings', settings: { kind: 'cup', cupId: 'sprout', trackId: 'meadow-loop', cc: 50, items: true } })
  assert.equal(e.conn.last().code, 'not_owner')
})

test('the last leave deletes the room', () => {
  const s = setup()
  const { owner, code } = createRoom(s)
  const b = joiner(s, code)
  b.send({ t: 'leave' })
  assert.equal(s.hub.stats().rooms, 1)
  s.hub.disconnect(owner.id)
  assert.deepEqual(s.hub.stats(), { rooms: 0, clients: 1 })
  b.send({ t: 'leave' })
  assert.equal(b.conn.last().code, 'not_in_room')
  assert.equal(joiner(s, code).conn.last().code, 'room_not_found')
})

test('rate limit: the 81st message at once is refused, 5 s of abuse closes with 4008', () => {
  const s = setup()
  const a = s.hello()
  a.conn.take()
  for (let i = 0; i < 79; i++) a.send({ t: 'ping', id: i })
  assert.equal(a.conn.sent.length, 79)
  assert.ok(a.conn.sent.every((m) => m.t === 'pong'))
  a.send({ t: 'ping', id: 80 })
  assert.equal(a.conn.last().code, 'rate_limited')
  s.hub.tick(T0 + 4999)
  assert.equal(a.conn.closes.length, 0)
  s.hub.tick(T0 + 5000)
  assert.deepEqual(a.conn.closes, [{ code: 4008, reason: 'rate_limited' }])
  assert.equal(s.hub.stats().clients, 0)
})

test('hello timeout closes with 4000 at 10 s but not at 9.9 s', () => {
  const s = setup()
  const a = s.connect()
  const b = s.hello()
  s.hub.tick(T0 + 9900)
  assert.equal(a.conn.closes.length, 0)
  s.hub.tick(T0 + 10000)
  assert.deepEqual(a.conn.closes, [{ code: 4000, reason: 'hello_timeout' }])
  assert.equal(b.conn.closes.length, 0)
  assert.equal(s.hub.stats().clients, 1)
})

test('idle lobby closes at 30 min; a room active at 29 min stays', () => {
  const s = setup()
  const idle = createRoom(s)
  const idleB = joiner(s, idle.code)
  const busy = createRoom(s)
  s.clock.now = T0 + 29 * 60 * 1000
  busy.owner.send({ t: 'ping', id: 1 })
  s.hub.tick(s.clock.now)
  assert.equal(s.hub.stats().rooms, 2)
  s.clock.now = T0 + 30 * 60 * 1000
  s.hub.tick(s.clock.now)
  assert.deepEqual(idle.owner.conn.closes, [{ code: 1000, reason: 'idle' }])
  assert.deepEqual(idleB.conn.closes, [{ code: 1000, reason: 'idle' }])
  assert.equal(busy.owner.conn.closes.length, 0)
  assert.deepEqual(s.hub.stats(), { rooms: 1, clients: 1 })
})

test('rid is echoed on a reply and on an error', () => {
  const s = setup()
  const a = s.hello()
  a.send({ t: 'ping', id: 7, rid: 'r1' })
  assert.deepEqual(a.conn.last(), { t: 'pong', rid: 'r1', id: 7 })
  a.send({ t: 'create', players: players(1), rid: 12 })
  assert.equal(a.conn.last().rid, 12)
  a.send({ t: 'leave', rid: 'r2' })
  a.send({ t: 'leave', rid: 'r3' })
  assert.deepEqual(a.conn.last(), { t: 'error', rid: 'r3', code: 'not_in_room', message: a.conn.last().message })
  a.send({ t: 'create', players: [], rid: 'r4' })
  assert.equal(a.conn.last().code, 'bad_players')
  assert.equal(a.conn.last().rid, 'r4')
  s.hub.message(a.id, 'x'.repeat(70000))
  assert.equal(a.conn.last().code, 'too_large')
  assert.deepEqual(a.conn.closes, [{ code: 4009, reason: 'too_large' }])
})

test('server_full at maxClients', () => {
  const s = setup({ MAX_CLIENTS: '2', MAX_ROOMS: '1' })
  const a = s.hello()
  s.hello()
  const conn = new FakeConn()
  assert.equal(s.hub.connect(conn), '')
  assert.equal(conn.last().code, 'server_full')
  assert.deepEqual(conn.closes, [{ code: 1013, reason: 'server_full' }])
  assert.equal(s.hub.stats().clients, 2)
  a.send({ t: 'create', players: players(1) })
  assert.equal(a.conn.last().t, 'room')
})

test('an exception in a handler is logged and answered with internal', () => {
  const s = setup()
  const b = s.hello()
  let n = 0
  s.hub.deps.seed = () => { n++; throw new Error('boom') }
  b.send({ t: 'create', players: players(1) })
  b.send({ t: 'start', rid: 5 })
  assert.equal(n, 1)
  assert.deepEqual(b.conn.last(), { t: 'error', rid: 5, code: 'internal', message: b.conn.last().message })
  assert.ok(s.logs.some((l) => l.startsWith('error ') && l.includes('boom')))
})
