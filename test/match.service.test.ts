import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { guestIdentity } from '../src/hooks.ts'
import type { HandshakeHooks } from '../src/hooks.ts'
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
  const deps = { now: () => clock.t, random: Math.random, log: () => {} }
  const service = new MatchService(deps, store, hooks)
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const add = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    const frame = (m: Record<string, unknown>) => hub.message(id, JSON.stringify(m))
    return { conn, id, frame }
  }
  return { hub, service, store, clock, add }
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
