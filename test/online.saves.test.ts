import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryTableApi } from '../src/store/tables.ts'
import { StoreError } from '../src/store/errors.ts'
import { createLimits } from '../src/online/limits.ts'
import { createSavesService, etagOf } from '../src/saves/service.ts'

function rig(settings: Record<string, string> = {}) {
  const clock = { t: 1_000_000 }
  const api = createMemoryTableApi()
  const seed = Promise.all(Object.entries(settings).map(([key, value]) => api.insert('etc_settings', { key, value })))
  const limits = createLimits(api, () => clock.t, 0)
  const saves = createSavesService({ api, limits, now: () => clock.t })
  return { api, clock, saves, seed }
}
const fails = async (p: Promise<unknown>, code: string): Promise<StoreError> => {
  try { await p } catch (e) { assert.ok(e instanceof StoreError, String(e)); assert.equal(e.code, code); return e }
  assert.fail(`expected ${code}`)
}

test('saves: create, update, read, list', async () => {
  const r = rig()
  const a = await r.saves.put('p1', 'decks', 0, '{"a":1}')
  assert.deepEqual([a.save.version, a.applied, a.save.size, a.save.etag], [1, true, 7, etagOf('{"a":1}')])
  const b = await r.saves.put('p1', 'decks', 1, '{"a":2}')
  assert.deepEqual([b.save.version, b.applied], [2, true])
  const got = await r.saves.get('p1', 'decks')
  assert.deepEqual([got!.version, got!.data], [2, '{"a":2}'])
  assert.equal(await r.saves.get('p1', 'nope'), null)
  await r.saves.put('p1', 'profile', 0, 'x')
  const l = await r.saves.list('p1')
  assert.deepEqual(l.saves.map(s => [s.key, s.version]), [['decks', 2], ['profile', 1]])
  assert.equal(l.quota.used, 8)
  assert.equal(l.quota.max_bytes, 2_097_152)
  // another player has nothing
  assert.deepEqual((await r.saves.list('p2')).saves, [])
  assert.equal(await r.saves.get('p2', 'decks'), null)
})

test('saves: compare-and-set refuses a stale write and returns the server copy', async () => {
  const r = rig()
  await r.saves.put('p1', 'k', 0, 'v1')
  await r.saves.put('p1', 'k', 1, 'v2')
  const e = await fails(r.saves.put('p1', 'k', 1, 'other'), 'version_conflict')
  assert.deepEqual(e.detail, { key: 'k', version: 2, etag: etagOf('v2'), size: 2, updated_at: 1_000_000, data: 'v2' })
  // creating something that exists, and updating something that does not
  await fails(r.saves.put('p1', 'k', 0, 'again'), 'version_conflict')
  const none = await fails(r.saves.put('p1', 'ghost', 3, 'x'), 'version_conflict')
  assert.equal(none.detail, null)
  assert.equal((await r.saves.get('p1', 'k'))!.data, 'v2')
})

test('saves: replaying the same write is a success that changes nothing', async () => {
  const r = rig()
  const first = await r.saves.put('p1', 'k', 0, 'same')
  const again = await r.saves.put('p1', 'k', 0, 'same')
  assert.deepEqual([again.applied, again.save.version], [false, 1])
  assert.deepEqual(again.save, first.save)
  // same base, other content: conflict, not a replay
  await fails(r.saves.put('p1', 'k', 0, 'different'), 'version_conflict')
})

test('saves: size per key, number of keys and total quota come from etc_settings', async () => {
  const r = rig({ 'saves.max_bytes': '10', 'saves.quota_bytes': '15', 'saves.max_keys': '2' })
  await r.seed
  await fails(r.saves.put('p1', 'big', 0, 'x'.repeat(11)), 'too_large')
  await fails(r.saves.put('p1', 'multi', 0, 'é'.repeat(6)), 'too_large') // 12 bytes in UTF-8
  await r.saves.put('p1', 'a', 0, 'x'.repeat(10))
  await fails(r.saves.put('p1', 'b', 0, 'y'.repeat(6)), 'quota_exceeded') // 10 + 6 > 15
  await r.saves.put('p1', 'b', 0, 'y'.repeat(5))
  await fails(r.saves.put('p1', 'c', 0, 'z'), 'quota_exceeded') // third key
  // rewriting an existing key does not count its old size twice
  await r.saves.put('p1', 'a', 1, 'w'.repeat(10))
  // quotas are per player
  await r.saves.put('p2', 'a', 0, 'x'.repeat(10))
})

test('saves: write rate limit per player', async () => {
  const r = rig({ 'saves.writes_per_minute': '3' })
  await r.seed
  for (let i = 0; i < 3; i++) await r.saves.put('p1', 'k', i, `v${i}`)
  await fails(r.saves.put('p1', 'k', 3, 'v3'), 'rate_limited')
  await r.saves.put('p2', 'k', 0, 'other player is not limited')
  r.clock.t += 61_000
  await r.saves.put('p1', 'k', 3, 'v3')
})

test('saves: delete is compare-and-set, leaves a tombstone and a recreate keeps counting versions', async () => {
  const r = rig()
  await r.saves.put('p1', 'k', 0, 'v1')
  await fails(r.saves.remove('p1', 'k', 5), 'version_conflict')
  assert.deepEqual(await r.saves.remove('p1', 'k', 1), { deleted: true, applied: true })
  assert.equal(await r.saves.get('p1', 'k'), null)
  assert.deepEqual((await r.saves.list('p1')).saves, [])
  assert.deepEqual(await r.saves.remove('p1', 'k', 1), { deleted: false, applied: false })
  const again = await r.saves.put('p1', 'k', 0, 'v1')
  assert.equal(again.save.version, 3) // 1 (create), 2 (tombstone), 3
  assert.equal((await r.saves.get('p1', 'k'))!.data, 'v1')
})

test('saves: invalid keys, versions and data are refused', async () => {
  const r = rig()
  for (const key of ['', '../x', 'a b', '-x', 'k'.repeat(65)]) await fails(r.saves.put('p1', key, 0, 'x'), 'bad_argument')
  await fails(r.saves.put('p1', 'k', -1, 'x'), 'bad_argument')
  await fails(r.saves.put('p1', 'k', 1.5, 'x'), 'bad_argument')
  await fails(r.saves.put('p1', 'k', 0, 5 as unknown as string), 'bad_argument')
  await fails(r.saves.get('p1', 'bad key'), 'bad_argument')
})

test('saves: two concurrent first writes, only one wins', async () => {
  const r = rig()
  const res = await Promise.allSettled([r.saves.put('p1', 'k', 0, 'a'), r.saves.put('p1', 'k', 0, 'b')])
  assert.deepEqual(res.map(x => x.status).sort(), ['fulfilled', 'rejected'])
  assert.equal((await r.saves.get('p1', 'k'))!.version, 1)
})
