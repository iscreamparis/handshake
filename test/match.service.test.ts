import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { guestIdentity } from '../src/hooks.ts'
import type { HandshakeHooks, MatchRecord, ResidentSeat } from '../src/hooks.ts'
import type { PlayerStore } from '../src/store/types.ts'

class FakeConn {
  sent: Record<string, unknown>[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void {}
  types(): unknown[] { return this.sent.map((m) => m.t) }
  last(): Record<string, unknown> | undefined { return this.sent.at(-1) }
}

const METHODS = ['getOrCreateByIdentity', 'getPlayer', 'getRating', 'applyRankedResult', 'lockRanked',
  'unlockRanked', 'balance', 'credit', 'debit', 'unopenedPacks', 'addPacks', 'openPack', 'collection',
  'leaderboard'] as const

function wrapStore(over: (base: PlayerStore) => Partial<PlayerStore>): PlayerStore {
  const base = createMemoryStore()
  const custom = over(base) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const m of METHODS) {
    out[m] = custom[m] ?? ((...args: unknown[]) => (base[m] as (...a: unknown[]) => unknown).apply(base, args))
  }
  return out as unknown as PlayerStore
}

function setup(store: PlayerStore = createMemoryStore(), hooks: HandshakeHooks = {}) {
  const clock = { t: 1_000_000 }
  const logs: string[] = []
  const deps = { now: () => clock.t, random: Math.random, log: (level: string, msg: string) => { logs.push(`${level} ${msg}`) } }
  const service = new MatchService(deps, store, hooks)
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const add = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    const frame = (m: Record<string, unknown>) => hub.message(id, JSON.stringify(m))
    return { conn, id, frame }
  }
  return { hub, service, store, clock, add, logs }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

const guest = (n: number) => ({ t: 'auth', provider: 'guest', token: `guest-token-${n}-abcdefgh` })

async function authedPair(s: ReturnType<typeof setup>, queue: string) {
  const a = s.add(), b = s.add()
  a.frame(guest(1)); b.frame(guest(2))
  await flush()
  a.frame({ t: 'match_queue', game: 'kekkai', queue })
  await flush()
  b.frame({ t: 'match_queue', game: 'kekkai', queue })
  await flush()
  return { a, b, idA: a.conn.sent[0].player_id as string, idB: b.conn.sent[0].player_id as string }
}

test('guest auth then queue', async () => {
  const s = setup()
  const a = s.add()
  a.frame({ ...guest(1), name: 'Kevin' })
  await flush()
  assert.deepEqual({ ...a.conn.sent[0], player_id: 'x' }, { t: 'authed', player_id: 'x', display_name: 'Kevin', provider: 'guest' })
  a.frame({ t: 'match_queue', game: 'kekkai', queue: 'ranked' })
  await flush()
  assert.deepEqual(a.conn.last(), { t: 'match_queued', game: 'kekkai', queue: 'ranked', rating: 2500, games: 0, placement: true })
  assert.equal(s.service.stats().queued, 1)
})

test('auth_required', async () => {
  const s = setup()
  const a = s.add()
  a.frame({ t: 'match_queue', game: 'kekkai', queue: 'quick' })
  await flush()
  assert.deepEqual(a.conn.sent, [{ t: 'error', reason: 'auth_required' }])
})

test('quick pairing sends match before matched', async () => {
  const s = setup()
  const { a, b, idA, idB } = await authedPair(s, 'quick')
  for (const [c, seat, opp] of [[a, 0, idB], [b, 1, idA]] as const) {
    const types = c.conn.types()
    assert.ok(types.indexOf('match') >= 0 && types.indexOf('match') < types.indexOf('matched'))
    const m = c.conn.sent.find((x) => x.t === 'match')!
    assert.equal(m.seat, seat)
    assert.equal((m.opponent as { player_id: string }).player_id, opp)
  }
  assert.deepEqual(s.service.stats(), { queued: 0, matches: 1 })
})

test('resident_cannot_queue', async () => {
  const store = createMemoryStore()
  await store.getOrCreateByIdentity({ provider: 'itch', external_id: 'res-1' }, { kind: 'resident' })
  const s = setup(store, {
    verifyIdentity: async (_p, token) => token === 'resident-token'
      ? { provider: 'itch', external_id: 'res-1', display_name: 'Resi' } : guestIdentity(token),
  })
  const a = s.add()
  a.frame({ t: 'auth', provider: 'itch', token: 'resident-token' })
  await flush()
  a.frame({ t: 'match_queue', game: 'kekkai', queue: 'quick' })
  await flush()
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'resident_cannot_queue' })
})

test('lock failure rollback', async () => {
  let calls = 0
  const store = wrapStore((base) => ({
    lockRanked: (id, m) => calls++ === 1 ? Promise.resolve(false) : base.lockRanked(id, m),
  }))
  const s = setup(store)
  const { a, b, idA } = await authedPair(s, 'ranked')
  assert.equal((await store.getPlayer(idA))!.active_ranked_match, null)
  assert.deepEqual(b.conn.last(), { t: 'error', reason: 'ranked_busy' })
  assert.equal(a.conn.last()!.t, 'match_queued')
  assert.deepEqual(s.service.stats(), { queued: 1, matches: 0 })
})

test('getRating rejection answers store_unavailable', async () => {
  const s = setup(wrapStore(() => ({ getRating: () => Promise.reject(new Error('db down')) })))
  const a = s.add()
  a.frame(guest(1))
  await flush()
  a.frame({ t: 'match_queue', game: 'kekkai', queue: 'quick' })
  await flush()
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'store_unavailable' })
  assert.equal(s.service.stats().queued, 0)
})

test('lockRanked rejection on seat 1 unlocks seat 0', async () => {
  let calls = 0
  const store = wrapStore((base) => ({
    lockRanked: (id, m) => calls++ === 1 ? Promise.reject(new Error('db down')) : base.lockRanked(id, m),
  }))
  const s = setup(store)
  const { a, b, idA } = await authedPair(s, 'ranked')
  assert.equal((await store.getPlayer(idA))!.active_ranked_match, null)
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'store_unavailable' })
  assert.deepEqual(b.conn.last(), { t: 'error', reason: 'store_unavailable' })
  assert.deepEqual(s.service.stats(), { queued: 0, matches: 0 })
})

type Pair = Awaited<ReturnType<typeof authedPair>>
type Side = Pair['a']
const matchOf = (c: Side) => c.conn.sent.find((m) => m.t === 'match')!.match_id as string
const ends = (c: Side) => c.conn.sent.filter((m) => m.t === 'match_end')
const report = (c: Side, outcome: string) => c.frame({ t: 'result', match_id: matchOf(c), outcome })

function recording(over: HandshakeHooks = {}) {
  const records: MatchRecord[] = []
  return { records, hooks: { ...over, onMatchEnd: over.onMatchEnd ?? ((r: MatchRecord) => { records.push(r) }) } }
}

test('agreement on quick completes the match', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await authedPair(s, 'quick')
  report(p.a, 'win')
  await flush()
  assert.deepEqual(p.a.conn.last(), { t: 'result_ack', match_id: matchOf(p.a) })
  report(p.b, 'loss')
  await flush()
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'complete')
  assert.equal(records[0].reason, 'agreed')
  assert.equal(records[0].score_a, 1)
  assert.deepEqual(records[0].players, [p.idA, p.idB])
  assert.deepEqual(ends(p.a), [{ t: 'match_end', match_id: matchOf(p.a), status: 'complete', outcome: 'win' }])
  assert.deepEqual(ends(p.b), [{ t: 'match_end', match_id: matchOf(p.b), status: 'complete', outcome: 'loss' }])
  assert.equal(s.service.stats().matches, 0)
  report(p.a, 'win')
  await flush()
  assert.deepEqual(p.a.conn.last(), { t: 'error', reason: 'unknown_match' })
})

test('agreement on ranked applies the rating', async () => {
  const s = setup()
  const p = await authedPair(s, 'ranked')
  report(p.a, 'loss'); report(p.a, 'loss')
  await flush()
  report(p.b, 'win')
  await flush()
  assert.deepEqual(p.a.conn.sent.filter((m) => m.t === 'error'), [{ t: 'error', reason: 'already_reported' }])
  assert.deepEqual(ends(p.b)[0].rating, { before: 2500, after: 2580, games: 1, placement: true })
  assert.equal(ends(p.a)[0].outcome, 'loss')
  assert.equal((await s.store.getPlayer(p.idA))!.active_ranked_match, null)
})

test('disagreement voids and clears both ranked locks', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await authedPair(s, 'ranked')
  assert.equal((await s.store.getPlayer(p.idA))!.active_ranked_match, matchOf(p.a))
  report(p.a, 'win'); report(p.b, 'win')
  await flush()
  assert.equal(records[0].status, 'void')
  assert.equal(records[0].reason, 'disagreement')
  assert.equal(records[0].ratings, null)
  assert.deepEqual(ends(p.a), [{ t: 'match_end', match_id: matchOf(p.a), status: 'void', outcome: null }])
  for (const id of [p.idA, p.idB]) assert.equal((await s.store.getPlayer(id))!.active_ranked_match, null)
  assert.equal((await s.store.getRating(p.idA, 'kekkai')).games, 0)
})

test('no_report voids RESULT_WAIT_MS after the first report', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await authedPair(s, 'quick')
  report(p.a, 'win')
  await flush()
  s.clock.t += 59999
  s.hub.tick(s.clock.t)
  await flush()
  assert.equal(records.length, 0)
  s.clock.t += 1
  s.hub.tick(s.clock.t)
  await flush()
  assert.deepEqual(records.map((r) => [r.status, r.reason]), [['void', 'no_report']])
  assert.equal(s.hub.stats().sessions, 0)
})

test('both_disconnected voids the match', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await authedPair(s, 'ranked')
  s.hub.disconnect(p.a.id); s.hub.disconnect(p.b.id)
  s.clock.t += 90001
  s.hub.tick(s.clock.t)
  await flush()
  assert.deepEqual(records.map((r) => [r.status, r.reason]), [['void', 'both_disconnected']])
  assert.equal((await s.store.getPlayer(p.idB))!.active_ranked_match, null)
  assert.deepEqual(s.service.stats(), { queued: 0, matches: 0 })
})

test('one seat absent past FORFEIT_MS forfeits', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await authedPair(s, 'ranked')
  s.hub.disconnect(p.a.id)
  s.clock.t += 90000
  s.hub.tick(s.clock.t)
  await flush()
  assert.deepEqual(records.map((r) => [r.status, r.reason, r.score_a]), [['forfeit', 'disconnect', 0]])
  assert.deepEqual(ends(p.b)[0].rating, { before: 2500, after: 2580, games: 1, placement: true })
  assert.equal(ends(p.b)[0].outcome, 'win')
})

test('a resume before 90 s cancels the forfeit', async () => {
  const { records, hooks } = recording()
  const s = setup(createMemoryStore(), hooks)
  const p = await authedPair(s, 'quick')
  const token = p.b.conn.sent.find((m) => m.t === 'matched')!.token as string
  s.hub.disconnect(p.b.id)
  s.clock.t += 30000
  const b2 = s.add()
  b2.frame({ t: 'resume', token })
  s.clock.t += 70000
  s.hub.tick(s.clock.t)
  await flush()
  assert.equal(records.length, 0)
  b2.frame({ t: 'result', match_id: matchOf(p.b), outcome: 'draw' })
  report(p.a, 'draw')
  await flush()
  assert.deepEqual(records.map((r) => [r.status, r.reason, r.score_a]), [['complete', 'agreed', 0.5]])
  assert.equal(ends(b2)[0].outcome, 'draw')
})

test('applyRankedResult rejection is retried at the next tick', async () => {
  let fail = true
  const store = wrapStore((base) => ({
    applyRankedResult: (o) => fail ? Promise.reject(new Error('db down')) : base.applyRankedResult(o),
  }))
  const s = setup(store)
  const p = await authedPair(s, 'ranked')
  report(p.a, 'win'); report(p.b, 'loss')
  await flush()
  assert.deepEqual(p.a.conn.last(), { t: 'error', reason: 'store_unavailable' })
  assert.equal(s.service.stats().matches, 1)
  fail = false
  s.hub.tick(s.clock.t)
  await flush()
  assert.equal(ends(p.a)[0].status, 'complete')
  assert.equal(s.service.stats().matches, 0)
})

test('an onMatchEnd that throws is logged and does not break the service', async () => {
  const s = setup(createMemoryStore(), { onMatchEnd: () => { throw new Error('host bug') } })
  const p = await authedPair(s, 'quick')
  report(p.a, 'win'); report(p.b, 'loss')
  await flush()
  assert.ok(s.logs.some((l) => l.startsWith('error [match] onMatchEnd failed')))
  assert.ok(s.logs.includes(`info [match] complete agreed ${matchOf(p.a)}`))
  assert.equal(ends(p.a).length, 1)
  p.a.frame({ t: 'match_unqueue' })
  await flush()
  assert.deepEqual(p.a.conn.last(), { t: 'error', reason: 'not_queued' })
})

function residentSeat(player_id: string) {
  const got: Record<string, unknown>[] = []
  let released = 0
  const seat: ResidentSeat = {
    player_id,
    socket: { send() {} },
    sink: { message: (text) => { got.push(JSON.parse(text)) } },
    release: () => { released++ },
  }
  return { seat, got, released: () => released }
}

async function residentSetup(kind: 'resident' | 'human', pick?: () => Promise<ResidentSeat | null>) {
  const store = createMemoryStore()
  const { player } = await store.getOrCreateByIdentity({ provider: 'itch', external_id: 'res-1' }, { kind, display_name: 'Resi' })
  const r = residentSeat(player.player_id)
  let calls = 0
  const s = setup(store, { pickResident: async () => { calls++; return pick ? pick() : r.seat } })
  const a = s.add()
  a.frame(guest(1))
  await flush()
  a.frame({ t: 'match_queue', game: 'kekkai', queue: 'quick' })
  await flush()
  const step = async (ms: number) => { s.clock.t += ms; s.hub.tick(s.clock.t); await flush() }
  return { s, a, r, step, calls: () => calls }
}

test('a quick waiter gets a resident at 8000 ms', async () => {
  const { s, a, r, step, calls } = await residentSetup('resident')
  await step(7999)
  assert.equal(calls(), 0)
  await step(1)
  assert.equal(calls(), 1)
  const types = a.conn.types()
  assert.ok(types.indexOf('match') >= 0 && types.indexOf('match') < types.indexOf('matched'))
  const m = a.conn.sent.find((x) => x.t === 'match')!
  assert.equal(m.seat, 0)
  assert.deepEqual(m.opponent, { player_id: r.seat.player_id, display_name: 'Resi' })
  const rt = r.got.map((x) => x.t)
  assert.ok(rt.indexOf('match') >= 0 && rt.indexOf('match') < rt.indexOf('matched'))
  assert.equal(r.got.find((x) => x.t === 'match')!.seat, 1)
  assert.equal(r.released(), 0)
  assert.deepEqual(s.service.stats(), { queued: 0, matches: 1 })
})

test('a seat whose player is human is released with an error log', async () => {
  const { s, r, step, calls } = await residentSetup('human')
  await step(8000)
  assert.equal(calls(), 1)
  assert.equal(r.released(), 1)
  assert.ok(s.logs.some((l) => l.startsWith('error [match] seat player')))
  assert.deepEqual(s.service.stats(), { queued: 1, matches: 0 })
})

test('a waiter that unqueued before the hook resolved releases the seat', async () => {
  let resolve!: (v: ResidentSeat | null) => void
  const { s, a, r, step } = await residentSetup('resident', () => new Promise((res) => { resolve = res }))
  await step(8000)
  a.frame({ t: 'match_unqueue' })
  await flush()
  resolve(r.seat)
  await flush()
  assert.equal(r.released(), 1)
  assert.deepEqual(s.service.stats(), { queued: 0, matches: 0 })
  assert.equal(r.got.length, 0)
})

test('a null answer is retried at the next tick, one call in flight', async () => {
  let resolve!: (v: ResidentSeat | null) => void
  const { s, step, calls } = await residentSetup('resident', () => new Promise((res) => { resolve = res }))
  await step(8000)
  await step(1000)
  await step(1000)
  assert.equal(calls(), 1)
  resolve(null)
  await flush()
  assert.equal(calls(), 1)
  await step(1000)
  assert.equal(calls(), 2)
  assert.deepEqual(s.service.stats(), { queued: 1, matches: 0 })
})

test('host frames through seat.socket.send reach the human as a relay act', async () => {
  const { s, a, r, step } = await residentSetup('resident')
  await step(8000)
  r.seat.socket.send(JSON.stringify({ t: 'act', a: { move: 3 } }))
  await flush()
  const act = a.conn.sent.find((x) => x.t === 'act')!
  assert.deepEqual(act.a, { move: 3 })
  assert.equal(act.from, 1)
  const mid = matchOf({ conn: a.conn } as Side)
  a.frame({ t: 'result', match_id: mid, outcome: 'win' })
  r.seat.socket.send(JSON.stringify({ t: 'result', match_id: mid, outcome: 'loss' }))
  await flush()
  assert.equal(r.got.filter((x) => x.t === 'match_end').length, 1)
  assert.deepEqual(s.service.stats(), { queued: 0, matches: 0 })
  assert.equal(s.hub.stats().clients, 1)
})
