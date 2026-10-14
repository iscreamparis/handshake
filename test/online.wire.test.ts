import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { parseMatchMessage } from '../src/match/messages.ts'
import { singleStoreRouter } from '../src/store/games.ts'
import { createOnline } from '../src/online/index.ts'
import { NOW_MS, rig } from './economy.helpers.ts'

class FakeConn {
  sent: Record<string, unknown>[] = []
  send(text: string): void { this.sent.push(JSON.parse(text)) }
  close(): void {}
  last(): Record<string, unknown> | undefined { return this.sent.at(-1) }
  all(t: string): Record<string, unknown>[] { return this.sent.filter(m => m.t === t) }
}
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)) }

async function world() {
  const r = await rig({ now: () => NOW_MS })
  const clock = { t: NOW_MS }
  const online = createOnline(r.api, { now: () => clock.t })
  await r.api.insert('etc_stats', { code: 'levels_done', value_type: 'int', aggregation: 'sum', client_writable: true, active: true, sort_order: 0 })
  await r.api.insert('etc_achievements', { code: 'first_win', title_fr: 'Premiere victoire', title_en: 'First win', rule_type: 'event', rule_event: 'match_end', rule_filter: 'outcome=win', active: true, secret: false, sort_order: 1 })
  await r.api.insert('etc_achievements', { code: 'opener', title_fr: 'Ouvreur', title_en: 'Opener', rule_type: 'stat', rule_stat: 'packs_opened', rule_threshold: 1, active: true, secret: false, sort_order: 2 })
  await r.api.insert('etc_achievements', { code: 'ten', title_fr: 'Dix', title_en: 'Ten', rule_type: 'stat', rule_stat: 'levels_done', rule_threshold: 2, active: true, secret: false, sort_order: 3 })
  const deps = { now: () => clock.t, random: Math.random, log: () => {} }
  const service = new MatchService(deps, singleStoreRouter(r.store, r.svc, online), {})
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const client = () => {
    const conn = new FakeConn()
    const id = hub.connect(conn, '/')
    return { conn, id, send: async (m: Record<string, unknown>) => { hub.message(id, JSON.stringify(m)); await flush() } }
  }
  const guest = async (n: number) => { const c = client(); await c.send({ t: 'auth', provider: 'guest', token: `guest-online-token-${n}-abc` }); return c }
  return { r, online, client, guest, hub, clock }
}

test('messages: parsed strictly', () => {
  assert.deepEqual(parseMatchMessage({ t: 'save_put', op: 'a', key: 'decks', base_version: 0, data: '{}' }), { t: 'save_put', op: 'a', key: 'decks', base_version: 0, data: '{}' })
  for (const bad of [
    { t: 'save_get' }, { t: 'save_get', key: 'bad key' }, { t: 'save_put', key: 'k', data: 'x' }, { t: 'save_put', key: 'k', base_version: -1, data: 'x' },
    { t: 'save_put', key: 'k', base_version: 0, data: 5 }, { t: 'save_delete', key: 'k' }, { t: 'stat_report', stat: 'a', value: 1 },
    { t: 'stat_report', op: 'o', stat: 'A B', value: 1 }, { t: 'stat_report', op: 'o', stat: 'a', value: 'x' }, { t: 'ach_ack', codes: [] },
    { t: 'ach_ack', codes: ['ok', 'Not Ok'] }, { t: 'ugc_update', base_version: 1 }, { t: 'ugc_list', limit: 99 }, { t: 'ugc_list', owner: 5 },
    { t: 'ugc_get' }, { t: 'ugc_delete', id: 5 }, { t: 'save_list', op: 'bad op' },
  ]) assert.ok('error' in (parseMatchMessage(bad) as object), JSON.stringify(bad))
  assert.equal((parseMatchMessage({ t: 'ugc_list', owner: 'me', limit: 10 }) as unknown as { limit: number }).limit, 10)
})

test('every online message needs auth', async () => {
  const w = await world()
  const c = w.client()
  for (const m of [{ t: 'save_list' }, { t: 'ach_list' }, { t: 'ugc_list' }, { t: 'stats_get' }]) {
    await c.send(m)
    assert.deepEqual(c.conn.last(), { t: 'error', reason: 'auth_required' })
  }
})

test('saves over the socket: put, conflict with the server copy, replay, delete', async () => {
  const w = await world()
  const a = await w.guest(1)
  await a.send({ t: 'save_get', op: 'g0', key: 'decks' })
  assert.deepEqual(a.conn.last(), { t: 'save_data', op: 'g0', key: 'decks', exists: false, version: 0, etag: '', size: 0, updated_at: 0, data: '' })
  await a.send({ t: 'save_put', op: 'p1', key: 'decks', base_version: 0, data: '{"d":1}' })
  assert.deepEqual([a.conn.last()!.t, a.conn.last()!.version, a.conn.last()!.applied, a.conn.last()!.op], ['save_ok', 1, true, 'p1'])
  await a.send({ t: 'save_put', op: 'p1b', key: 'decks', base_version: 0, data: '{"d":1}' })
  assert.deepEqual([a.conn.last()!.t, a.conn.last()!.version, a.conn.last()!.applied], ['save_ok', 1, false])
  // a second device with a stale view
  const b = w.client()
  await b.send({ t: 'auth', provider: 'guest', token: 'guest-online-token-1-abc' })
  await b.send({ t: 'save_put', key: 'decks', base_version: 0, data: '{"d":"other device"}' })
  assert.deepEqual(b.conn.last(), { t: 'save_conflict', key: 'decks', exists: true, version: 1, etag: a.conn.last()!.etag, size: 7, updated_at: NOW_MS, data: '{"d":1}' })
  await b.send({ t: 'save_put', key: 'decks', base_version: 1, data: '{"d":2}' })
  assert.equal(b.conn.last()!.version, 2)
  await a.send({ t: 'save_list' })
  const l = a.conn.last()!
  assert.equal(l.t, 'save_list')
  assert.equal((l.saves as Array<{ version: number }>)[0]!.version, 2)
  await a.send({ t: 'save_delete', key: 'decks', base_version: 1 })
  assert.equal(a.conn.last()!.t, 'save_conflict')
  await a.send({ t: 'save_delete', key: 'decks', base_version: 2 })
  assert.deepEqual([a.conn.last()!.t, a.conn.last()!.deleted], ['save_deleted', true])
  // limits are error codes
  await a.send({ t: 'save_put', op: 'big', key: 'huge', base_version: 0, data: 'x'.repeat(262_145) })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'too_large', op: 'big' })
  // another player's saves are separate
  const o = await w.guest(2)
  await o.send({ t: 'save_get', key: 'decks' })
  assert.equal(o.conn.last()!.exists, false)
})

test('stats and achievements over the socket: report pushes unlocks, ack, list', async () => {
  const w = await world()
  const a = await w.guest(1)
  await a.send({ t: 'stat_report', op: 's1', stat: 'levels_done', value: 1 })
  assert.deepEqual(a.conn.last(), { t: 'stat_value', op: 's1', stat: 'levels_done', value: 1, applied: true })
  await a.send({ t: 'stat_report', op: 's2', stat: 'levels_done', value: 1 })
  const push = a.conn.last()!
  assert.equal(push.t, 'ach_unlocked')
  assert.deepEqual((push.achievements as Array<{ code: string }>).map(x => x.code), ['ten'])
  await a.send({ t: 'stat_report', op: 's2', stat: 'levels_done', value: 1 })
  assert.deepEqual([a.conn.last()!.value, a.conn.last()!.applied], [2, false])
  await a.send({ t: 'stat_report', op: 's3', stat: 'matches_won', value: 99 })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'stat_not_writable', op: 's3' })
  await a.send({ t: 'stat_report', op: 's4', stat: 'nope', value: 1 })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'unknown_stat', op: 's4' })
  await a.send({ t: 'ach_list' })
  const list = a.conn.last()!
  assert.deepEqual(list.pending_sync, ['ten'])
  assert.equal((list.achievements as unknown[]).length, 3)
  await a.send({ t: 'ach_ack', op: 'k1', codes: ['ten'] })
  assert.deepEqual(a.conn.last(), { t: 'ach_acked', op: 'k1', codes: ['ten'] })
  await a.send({ t: 'stats_get' })
  assert.deepEqual(a.conn.last(), { t: 'stats', stats: { levels_done: 2 } })
})

test('server events unlock: opening a pack, then a finished match', async () => {
  const w = await world()
  const a = await w.guest(1)
  await a.send({ t: 'eco_reward', reward_id: 'bonus:1' })
  await a.send({ t: 'eco_buy', op: 'b1', product: 'pack-shop' })
  await a.send({ t: 'eco_open', op: 'o1', pack_type: 'shop' })
  const kinds = a.conn.sent.map(m => m.t)
  assert.ok(kinds.indexOf('eco_opened') < kinds.indexOf('ach_unlocked'))
  assert.deepEqual((a.conn.all('ach_unlocked')[0]!.achievements as Array<{ code: string }>).map(x => x.code), ['opener'])
  // a replayed open (same op) does not count the pack twice
  await a.send({ t: 'eco_open', op: 'o1', pack_type: 'shop' })
  assert.equal((await w.online.progress.stats(a.conn.all('authed')[0]!.player_id as string)).packs_opened, 1)

  const b = await w.guest(2)
  await a.send({ t: 'match_queue', game: 'g', queue: 'quick' })
  await b.send({ t: 'match_queue', game: 'g', queue: 'quick' })
  const m = a.conn.all('match')[0]!
  assert.ok(m)
  await a.send({ t: 'result', match_id: m.match_id, outcome: 'win' })
  await b.send({ t: 'result', match_id: m.match_id, outcome: 'loss' })
  await flush()
  const won = a.conn.all('ach_unlocked').flatMap(x => (x.achievements as Array<{ code: string }>).map(y => y.code))
  assert.ok(won.includes('first_win'), JSON.stringify(a.conn.sent.map(x => x.t)))
  assert.equal(b.conn.all('ach_unlocked').length, 0) // the loser unlocks nothing
  const bid = b.conn.all('authed')[0]!.player_id as string
  assert.deepEqual([(await w.online.progress.stats(bid)).matches_lost, (await w.online.progress.stats(bid)).win_streak_current], [1, 0])
})

test('ugc over the socket', async () => {
  const w = await world()
  const a = await w.guest(1)
  const b = await w.guest(2)
  await a.send({ t: 'ugc_create', op: 'c1', type: 'COMMUNITY', title: 'Track', visibility: 'PUBLIC', content_type: 'json', content: '{"c":[1]}' })
  const saved = a.conn.last()!
  assert.equal(saved.t, 'ugc_saved')
  const id = (saved.item as { id: string }).id
  await a.send({ t: 'ugc_create', op: 'c1', type: 'COMMUNITY', title: 'Track', visibility: 'PUBLIC', content_type: 'json', content: '{"c":[1]}' })
  assert.deepEqual([(a.conn.last()!.item as { id: string }).id, a.conn.last()!.applied], [id, false])
  await b.send({ t: 'ugc_list', type: 'COMMUNITY' })
  assert.deepEqual((b.conn.last()!.items as Array<{ id: string }>).map(x => x.id), [id])
  assert.equal(b.conn.last()!.next_cursor, null)
  await b.send({ t: 'ugc_get', id })
  assert.equal((b.conn.last()!.item as { content: string }).content, '{"c":[1]}')
  await b.send({ t: 'ugc_update', id, title: 'mine now' })
  assert.deepEqual(b.conn.last(), { t: 'error', reason: 'forbidden' })
  await b.send({ t: 'ugc_delete', id })
  assert.deepEqual(b.conn.last(), { t: 'error', reason: 'forbidden' })
  await a.send({ t: 'ugc_update', id, op: 'u1', title: 'Renamed', base_version: 5 })
  assert.equal(a.conn.last()!.reason, 'version_conflict')
  assert.equal((a.conn.last()!.item as { version: number }).version, 1)
  await a.send({ t: 'ugc_update', id, title: 'Renamed', base_version: 1 })
  assert.equal((a.conn.last()!.item as { title: string }).title, 'Renamed')
  await a.send({ t: 'ugc_create', title: 'Bad', content_type: 'json', content: '{' })
  assert.deepEqual(a.conn.last(), { t: 'error', reason: 'bad_message' })
  await a.send({ t: 'ugc_delete', id })
  assert.deepEqual(a.conn.last(), { t: 'ugc_deleted', id, deleted: true })
  await b.send({ t: 'ugc_get', id })
  assert.deepEqual(b.conn.last(), { t: 'error', reason: 'not_found' })
})

test('without the online services the messages answer online_unavailable', async () => {
  const r = await rig({ now: () => NOW_MS })
  const deps = { now: () => NOW_MS, random: Math.random, log: () => {} }
  const service = new MatchService(deps, singleStoreRouter(r.store, r.svc), {})
  const hub = new RelayHub(deps, service)
  service.attach(hub)
  const conn = new FakeConn()
  const id = hub.connect(conn, '/')
  hub.message(id, JSON.stringify({ t: 'auth', provider: 'guest', token: 'guest-online-token-9-abc' }))
  await flush()
  hub.message(id, JSON.stringify({ t: 'save_list' }))
  await flush()
  assert.deepEqual(conn.last(), { t: 'error', reason: 'online_unavailable' })
})

test('frame size: extension messages may be large, relay messages stay at 4 KiB', async () => {
  const { parseRelayMessage, MAX_EXT_BYTES } = await import('../src/relay/protocol.ts')
  const big = JSON.stringify({ t: 'save_put', key: 'k', base_version: 0, data: 'x'.repeat(100_000) })
  assert.ok('ext' in parseRelayMessage(big))
  assert.deepEqual(parseRelayMessage(JSON.stringify({ t: 'create', players: 2, pad: 'x'.repeat(5000) })), { error: 'bad_message', message: 'message too large' })
  assert.deepEqual(parseRelayMessage('x'.repeat(5000)), { error: 'bad_message', message: 'message too large' })
  assert.deepEqual(parseRelayMessage(JSON.stringify({ t: 'save_put', data: 'x'.repeat(MAX_EXT_BYTES) })), { error: 'bad_message', message: 'message too large' })
})
