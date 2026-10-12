import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayHub } from '../src/relay/hub.ts'
import type { RelayExtension, RelaySeatRef } from '../src/relay/hub.ts'
import { MAX_INVALID, RESUME_GRACE_MS } from '../src/relay/protocol.ts'

class FakeConn {
  sent: Record<string, unknown>[] = []
  closes = 0
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void { this.closes++ }
  types(): unknown[] { return this.sent.map((m) => m.t) }
}

function setup(ext?: RelayExtension) {
  const clock = { t: 1_000_000 }
  let seed = 7
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const hub = new RelayHub({ now: () => clock.t, random, log: () => {} }, ext)
  const add = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    return { conn, id }
  }
  return { hub, clock, add }
}

function recorder() {
  const calls: { kind: string; args: unknown[] }[] = []
  let handled = false
  const ext: RelayExtension = {
    message: (...args) => { calls.push({ kind: 'message', args }); return handled },
    connClosed: (...args) => { calls.push({ kind: 'connClosed', args }) },
    seatResumed: (...args) => { calls.push({ kind: 'seatResumed', args }) },
    sessionEnded: (...args) => { calls.push({ kind: 'sessionEnded', args }) },
    tick: () => {},
  }
  return { ext, calls, setHandled: (v: boolean) => { handled = v } }
}

const q = JSON.stringify({ t: 'queue', payload: { n: 1 } })

function quickPair(s: ReturnType<typeof setup>) {
  const a = s.add(), b = s.add()
  s.hub.message(a.id, q)
  s.hub.message(b.id, q)
  return { a, b }
}

const shape = (m: Record<string, unknown>) => Object.keys(m).sort().join(',')

test('code pairing then an action is relayed to the peer only', () => {
  const s = setup()
  const a = s.add(), b = s.add()
  s.hub.message(a.id, JSON.stringify({ t: 'create' }))
  const code = a.conn.sent[0].code as string
  assert.equal(a.conn.sent[0].t, 'room')
  s.hub.message(b.id, JSON.stringify({ t: 'join', code }))
  assert.equal(a.conn.types().at(-1), 'matched')
  assert.equal(b.conn.types().at(-1), 'matched')
  const na = a.conn.sent.length, nb = b.conn.sent.length
  s.hub.message(a.id, JSON.stringify({ t: 'act', a: { x: 1 }, n: 1 }))
  assert.deepEqual(a.conn.sent.slice(na), [{ t: 'ack', n: 1 }])
  assert.deepEqual(b.conn.sent.slice(nb), [{ t: 'act', a: { x: 1 }, n: 1, from: 0 }])
})

test('legacy quick queue pairs two clients', () => {
  const s = setup()
  const a = s.add(), b = s.add()
  s.hub.message(a.id, q)
  assert.equal(a.conn.sent[0].t, 'queued')
  s.hub.message(b.id, q)
  const ma = a.conn.sent.at(-1)!, mb = b.conn.sent.at(-1)!
  assert.equal(ma.t, 'matched')
  assert.equal(ma.youAre, 0)
  assert.equal(mb.youAre, 1)
  assert.equal(typeof ma.token, 'string')
  assert.notEqual(ma.token, mb.token)
  assert.equal(s.hub.stats().sessions, 1)
})

test('unknown type without an extension is silently counted as invalid', () => {
  const s = setup()
  const a = s.add()
  for (let i = 0; i < MAX_INVALID - 1; i++) s.hub.message(a.id, JSON.stringify({ t: 'nope' }))
  assert.equal(a.conn.sent.length, 0)
  assert.equal(a.conn.closes, 0)
  s.hub.message(a.id, JSON.stringify({ t: 'nope' }))
  assert.equal(a.conn.sent.length, 0)
  assert.equal(a.conn.closes, 1)
  assert.equal(s.hub.stats().clients, 0)
})

test('extension receives non-relay messages; true means no client reply', () => {
  const r = recorder()
  const s = setup(r.ext)
  const a = s.add()
  r.setHandled(true)
  s.hub.message(a.id, JSON.stringify({ t: 'auth', token: 'x' }))
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].kind, 'message')
  assert.deepEqual(r.calls[0].args, [a.id, { t: 'auth', token: 'x' }])
  assert.equal(a.conn.sent.length, 0)
  assert.equal(a.conn.closes, 0)
})

test('resume inside the window takes the seat back and replays the log', () => {
  const r = recorder()
  const s = setup(r.ext)
  const { a, b } = quickPair(s)
  const token = (b.conn.sent.at(-1)!.token) as string
  s.hub.message(a.id, JSON.stringify({ t: 'act', a: { x: 1 }, n: 1 }))
  s.hub.message(a.id, JSON.stringify({ t: 'act', a: { x: 2 }, n: 2 }))
  s.hub.disconnect(b.id)
  assert.equal(a.conn.types().at(-1), 'opp_dropped')
  assert.equal(a.conn.sent.at(-1)!.graceMs, RESUME_GRACE_MS)
  assert.equal(r.calls.at(-1)!.kind, 'connClosed')
  assert.deepEqual((r.calls.at(-1)!.args[1] as RelaySeatRef).seat, 1)

  s.clock.t += RESUME_GRACE_MS - 1
  s.hub.tick(s.clock.t)
  assert.equal(s.hub.stats().sessions, 1)
  const b2 = s.add()
  s.hub.message(b2.id, JSON.stringify({ t: 'resume', token, have: 0 }))
  assert.deepEqual(b2.conn.sent.map((m) => m.t), ['resumed', 'act', 'act'])
  assert.equal(b2.conn.sent[0].ack, 0)
  assert.equal(b2.conn.sent[2].n, 2)
  assert.equal(a.conn.types().at(-1), 'opp_back')
  assert.deepEqual(s.hub.seatOf(b2.id), { session: s.hub.seatOf(a.id)!.session, seat: 1, conn: b2.id })
  const resumed = r.calls.filter((c) => c.kind === 'seatResumed')
  assert.equal(resumed.length, 1)
  assert.equal((resumed[0].args[0] as RelaySeatRef).conn, b2.id)
})

test('resume after the window fails and the session ends', () => {
  const r = recorder()
  const s = setup(r.ext)
  const { a, b } = quickPair(s)
  const token = (b.conn.sent.at(-1)!.token) as string
  s.hub.disconnect(b.id)
  s.clock.t += RESUME_GRACE_MS
  s.hub.tick(s.clock.t)
  assert.equal(a.conn.types().at(-1), 'opp_left')
  assert.equal(s.hub.stats().sessions, 0)
  assert.equal(r.calls.filter((c) => c.kind === 'sessionEnded').length, 1)
  const b2 = s.add()
  s.hub.message(b2.id, JSON.stringify({ t: 'resume', token }))
  assert.deepEqual(b2.conn.sent, [{ t: 'error', reason: 'resume expired' }])
})

test('pairInto sends the quick-queue frames and honours holdMs', () => {
  const r = recorder()
  const s = setup(r.ext)
  const quick = quickPair(s)
  const qa = quick.a.conn.sent.at(-1)!, qb = quick.b.conn.sent.at(-1)!

  const a = s.add(), b = s.add()
  const [ra, rb] = s.hub.pairInto(a.id, b.id, { holdMs: RESUME_GRACE_MS + 30_000 })
  assert.equal(ra.seat, 0)
  assert.equal(rb.seat, 1)
  assert.equal(ra.conn, a.id)
  assert.equal(ra.session, rb.session)
  assert.equal(a.conn.sent.length, 1)
  assert.equal(b.conn.sent.length, 1)
  const pa = a.conn.sent[0], pb = b.conn.sent[0]
  assert.equal(shape(pa), shape(qa))
  assert.equal(shape(pb), shape(qb))
  assert.equal(pa.youAre, 0)
  assert.equal(pb.youAre, 1)
  assert.equal(typeof pa.token, 'string')
  assert.deepEqual(s.hub.seatOf(a.id), ra)

  const token = pb.token as string
  s.hub.message(a.id, JSON.stringify({ t: 'act', a: { x: 5 }, n: 1 }))
  s.hub.disconnect(b.id)
  assert.equal(a.conn.sent.at(-1)!.graceMs, RESUME_GRACE_MS + 30_000)
  s.clock.t += RESUME_GRACE_MS + 10_000
  s.hub.tick(s.clock.t)
  assert.equal(s.hub.seatOf(a.id)?.session, ra.session)
  const b2 = s.add()
  s.hub.message(b2.id, JSON.stringify({ t: 'resume', token }))
  assert.deepEqual(b2.conn.sent.map((m) => m.t), ['resumed', 'act'])
  assert.equal(s.hub.seatOf(b2.id)?.seat, 1)
})

test('endSession notifies like relay.mjs and seatOf becomes null', () => {
  const r = recorder()
  const s = setup(r.ext)
  const { a, b } = quickPair(s)
  const ref = s.hub.seatOf(a.id)!
  assert.ok(s.hub.seatOf(b.id))
  s.hub.endSession(ref.session, 'done')
  assert.equal(a.conn.types().at(-1), 'opp_left')
  assert.equal(b.conn.types().at(-1), 'opp_left')
  assert.equal(a.conn.closes, 0)
  assert.equal(s.hub.seatOf(a.id), null)
  assert.equal(s.hub.seatOf(b.id), null)
  assert.equal(s.hub.stats().sessions, 0)
  assert.deepEqual(r.calls.filter((c) => c.kind === 'sessionEnded').map((c) => c.args), [[ref.session]])
})
