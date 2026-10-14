import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryTableApi } from '../src/store/tables.ts'
import { StoreError } from '../src/store/errors.ts'
import { createLimits } from '../src/online/limits.ts'
import { createUgcService } from '../src/ugc/service.ts'

function rig(settings: Record<string, string> = {}) {
  const clock = { t: 2_000_000 }
  const api = createMemoryTableApi()
  const seed = Promise.all(Object.entries(settings).map(([key, value]) => api.insert('etc_settings', { key, value })))
  const ugc = createUgcService({ api, limits: createLimits(api, () => clock.t, 0), now: () => clock.t })
  return { api, clock, ugc, seed }
}
const fails = async (p: Promise<unknown>, code: string): Promise<StoreError> => {
  try { await p } catch (e) { assert.ok(e instanceof StoreError, String(e)); assert.equal(e.code, code); return e }
  assert.fail(`expected ${code}`)
}
const level = (title: string, over: Record<string, unknown> = {}) => ({ type: 'COMMUNITY', title, visibility: 'PUBLIC', content_type: 'json', content: '{"cells":[1,2,3]}', ...over })

test('ugc: create, read, list', async () => {
  const r = rig()
  const { item, applied } = await r.ugc.create('p1', level('Track A', { description: 'my first track' }))
  assert.equal(applied, true)
  assert.match(item.id, /^u_[0-9a-f]{32}$/)
  assert.deepEqual([item.owner, item.type, item.visibility, item.version, item.size, item.hidden], ['p1', 'COMMUNITY', 'PUBLIC', 1, 17, false])
  const got = await r.ugc.get('p2', item.id) // public: anyone reads it
  assert.equal(got.content, '{"cells":[1,2,3]}')
  assert.equal(got.title, 'Track A')
  const l = await r.ugc.list('p2', {})
  assert.deepEqual(l.items.map(i => i.id), [item.id])
  assert.ok(!('content' in l.items[0]!))
})

test('ugc: private items exist only for their owner', async () => {
  const r = rig()
  const priv = (await r.ugc.create('p1', level('Secret', { visibility: 'PRIVATE' }))).item
  const pub = (await r.ugc.create('p1', level('Open'))).item
  assert.deepEqual((await r.ugc.list('p1', { owner: 'me' })).items.map(i => i.id).sort(), [priv.id, pub.id].sort())
  assert.deepEqual((await r.ugc.list('p2', {})).items.map(i => i.id), [pub.id])
  assert.deepEqual((await r.ugc.list('p2', { owner: 'p1' })).items.map(i => i.id), [pub.id])
  assert.deepEqual((await r.ugc.list('p2', { owner: 'p1', visibility: 'PRIVATE' })).items, [])
  assert.deepEqual((await r.ugc.list('p1', { owner: 'p1', visibility: 'PRIVATE' })).items.map(i => i.id), [priv.id])
  await fails(r.ugc.get('p2', priv.id), 'not_found')
  await fails(r.ugc.update('p2', priv.id, { title: 'x' }), 'not_found')
  await fails(r.ugc.remove('p2', priv.id), 'not_found')
  assert.equal((await r.ugc.get('p1', priv.id)).title, 'Secret')
})

test('ugc: only the owner updates or deletes', async () => {
  const r = rig()
  const it = (await r.ugc.create('p1', level('Mine'))).item
  await fails(r.ugc.update('p2', it.id, { title: 'hijack' }), 'forbidden')
  await fails(r.ugc.remove('p2', it.id), 'forbidden')
  const up = await r.ugc.update('p1', it.id, { title: 'Renamed', content: '{"cells":[]}' })
  assert.deepEqual([up.item.title, up.item.version, up.item.size, up.applied], ['Renamed', 2, 12, true])
  assert.equal((await r.ugc.get('p2', it.id)).content, '{"cells":[]}')
  const none = await r.ugc.update('p1', it.id, {})
  assert.equal(none.applied, false)
  // optional compare-and-set
  await fails(r.ugc.update('p1', it.id, { title: 'late' }, 1), 'version_conflict')
  assert.equal((await r.ugc.update('p1', it.id, { visibility: 'PRIVATE' }, 2)).item.version, 3)
  await fails(r.ugc.get('p2', it.id), 'not_found')
  assert.deepEqual(await r.ugc.remove('p1', it.id), { deleted: true })
  await fails(r.ugc.get('p1', it.id), 'not_found')
  assert.deepEqual((await r.ugc.list('p1', { owner: 'me' })).items, [])
})

test('ugc: an admin-hidden item disappears for everyone but its owner', async () => {
  const r = rig()
  const it = (await r.ugc.create('p1', level('Bad'))).item
  const row = r.api.rows('etc_ugc')[0]!
  await r.api.update('etc_ugc', row.id as number, { hidden: true })
  await fails(r.ugc.get('p2', it.id), 'not_found')
  assert.deepEqual((await r.ugc.list('p2', {})).items, [])
  const own = await r.ugc.get('p1', it.id)
  assert.equal(own.hidden, true)
})

test('ugc: content is validated and bounded; quotas come from etc_settings', async () => {
  const r = rig({ 'ugc.max_bytes': '30', 'ugc.quota_bytes': '50', 'ugc.max_items': '3' })
  await r.seed
  await fails(r.ugc.create('p1', level('Bad json', { content: '{nope' })), 'bad_argument')
  await fails(r.ugc.create('p1', level('Bad b64', { content_type: 'base64', content: 'abc' })), 'bad_argument')
  await r.ugc.create('p1', level('B64', { content_type: 'base64', content: 'aGVsbG8=' }))
  await fails(r.ugc.create('p1', level('Big', { content_type: 'text', content: 'x'.repeat(31) })), 'too_large')
  await fails(r.ugc.create('p1', level('', { content: '1' })), 'bad_argument')
  await fails(r.ugc.create('p1', level('t'.repeat(81), { content: '1' })), 'bad_argument')
  await fails(r.ugc.create('p1', level('Type', { type: 'HACK', content: '1' })), 'bad_argument')
  await fails(r.ugc.create('p1', level('Vis', { visibility: 'FRIENDS', content: '1' })), 'bad_argument')
  await fails(r.ugc.create('p1', level('Ref', { wavedash_ref: 'bad ref!', content: '1' })), 'bad_argument')
  await r.ugc.create('p1', level('Two', { content_type: 'text', content: 'x'.repeat(30) }))
  await fails(r.ugc.create('p1', level('Over', { content_type: 'text', content: 'y'.repeat(20) })), 'quota_exceeded') // 8 + 30 + 20 > 50
  await r.ugc.create('p1', level('Three', { content_type: 'text', content: 'z' }))
  await fails(r.ugc.create('p1', level('Four', { content_type: 'text', content: 'z' })), 'quota_exceeded') // 3 items
  await r.ugc.create('p2', level('Other player', { content_type: 'text', content: 'z' })) // quotas are per player
})

test('ugc: deleting frees the quota; a rewritten item is checked against the quota without counting itself twice', async () => {
  const r = rig({ 'ugc.quota_bytes': '20', 'ugc.max_items': '2' })
  await r.seed
  const a = (await r.ugc.create('p1', level('A', { content_type: 'text', content: 'x'.repeat(20) }))).item
  await fails(r.ugc.create('p1', level('B', { content_type: 'text', content: 'y' })), 'quota_exceeded')
  await r.ugc.update('p1', a.id, { content: 'z'.repeat(20) })
  await r.ugc.remove('p1', a.id)
  await r.ugc.create('p1', level('B', { content_type: 'text', content: 'y'.repeat(20) }))
})

test('ugc: create with an op is idempotent', async () => {
  const r = rig()
  const a = await r.ugc.create('p1', level('Once'), 'op-1')
  const b = await r.ugc.create('p1', level('Once'), 'op-1')
  assert.deepEqual([a.applied, b.applied, b.item.id], [true, false, a.item.id])
  assert.equal((await r.ugc.list('p1', { owner: 'me' })).items.length, 1)
  const c = await r.ugc.create('p2', level('Once'), 'op-1') // the op is per player
  assert.notEqual(c.item.id, a.item.id)
})

test('ugc: cursor pagination, newest first, with filters', async () => {
  const r = rig()
  const ids: string[] = []
  for (let i = 0; i < 7; i++) ids.push((await r.ugc.create('p1', level(`L${i}`, { type: i % 2 ? 'SCREENSHOT' : 'COMMUNITY', content_type: 'text', content: String(i) }))).item.id)
  const seen: string[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await r.ugc.list('p2', { limit: 3, cursor })
    seen.push(...page.items.map(i => i.id))
    cursor = page.next_cursor ?? undefined
    pages++
  } while (cursor)
  assert.deepEqual(seen, [...ids].reverse())
  assert.equal(pages, 3)
  const shots = await r.ugc.list('p2', { type: 'SCREENSHOT' })
  assert.deepEqual(shots.items.map(i => i.title), ['L5', 'L3', 'L1'])
  // a deleted item is skipped by the pages
  await r.ugc.remove('p1', ids[6]!)
  const first = await r.ugc.list('p2', { limit: 3 })
  assert.deepEqual(first.items.map(i => i.title), ['L5', 'L4', 'L3'])
  assert.notEqual(first.next_cursor, null)
  await fails(r.ugc.list('p2', { limit: 0 }), 'bad_argument')
  await fails(r.ugc.list('p2', { limit: 51 }), 'bad_argument')
  await fails(r.ugc.list('p2', { cursor: 'abc' }), 'bad_argument')
  await fails(r.ugc.list('p2', { type: 'NOPE' }), 'bad_argument')
})

test('ugc: write rate limit', async () => {
  const r = rig({ 'ugc.writes_per_minute': '2' })
  await r.seed
  await r.ugc.create('p1', level('1', { content: '1' }))
  await r.ugc.create('p1', level('2', { content: '1' }))
  await fails(r.ugc.create('p1', level('3', { content: '1' })), 'rate_limited')
  r.clock.t += 61_000
  await r.ugc.create('p1', level('3', { content: '1' }))
})

test('ugc: invalid ids are refused', async () => {
  const r = rig()
  await fails(r.ugc.get('p1', '../x'), 'bad_argument')
  await fails(r.ugc.get('p1', 'u_00000000000000000000000000000000'), 'not_found')
})
