import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayHub } from '../src/relay/hub.ts'
import { MatchService } from '../src/match/service.ts'
import { loadStoreConfig } from '../src/store/config.ts'
import { createGameRouter } from '../src/store/games.ts'
import { createGameSettings, DEFAULT_GAME_PARAMS, parseGameRow } from '../src/store/gamesettings.ts'
import { openStores } from '../src/store/setup.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import type { TableApi } from '../src/store/tables.ts'
import { DEFAULT_ELO, kFactor, nextRating } from '../src/store/elo.ts'
import { defaultVerifiers, verifyIdentityHook } from '../src/identity.ts'
import type { HandshakeHooks } from '../src/hooks.ts'

const KEY_A = 'gsk_secret_key_for_game_a_0001'
const KEY_B = 'gsk_secret_key_for_game_b_0002'
const URL_T = 'https://tenant.example'

const gameRow = (game: string, over: Record<string, unknown> = {}) => ({
  code: `code-${game}`, name: game, repo_url: '', repo_branch: 'main', handshake_game: game,
  elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick","ranked"]', ...over,
})

async function tenant(game: string, over: Record<string, unknown> = {}) {
  const api = createMemoryTableApi()
  await api.insert('etc_game', gameRow(game, over))
  return api
}

// --- configuration ---------------------------------------------------------------------------

test('config: memory by default, http needs url and one key per game', () => {
  assert.deepEqual(loadStoreConfig({}), { mode: 'memory' })
  assert.deepEqual(loadStoreConfig({ PLAYER_STORE: 'memory' }), { mode: 'memory' })
  const cfg = loadStoreConfig({ PLAYER_STORE: 'http', ETCITO_URL: URL_T, ETCITO_GAME_KEYS: JSON.stringify({ 'game-a': KEY_A, 'game-b': KEY_B }) })
  assert.deepEqual(cfg, { mode: 'http', baseUrl: URL_T, games: { 'game-a': KEY_A, 'game-b': KEY_B } })
})

test('config: invalid values are refused with a message that never shows a key', () => {
  const ok = { PLAYER_STORE: 'http', ETCITO_URL: URL_T, ETCITO_GAME_KEYS: JSON.stringify({ g: KEY_A }) }
  const bad: Record<string, string | undefined>[] = [
    { ...ok, PLAYER_STORE: 'redis' },
    { ...ok, ETCITO_URL: undefined },
    { ...ok, ETCITO_URL: 'not a url' },
    { ...ok, ETCITO_URL: 'ftp://x.example' },
    { ...ok, ETCITO_URL: 'https://user:pw@x.example' },
    { ...ok, ETCITO_GAME_KEYS: undefined },
    { ...ok, ETCITO_GAME_KEYS: `{"g":"${KEY_A}"` }, // truncated JSON that contains a key
    { ...ok, ETCITO_GAME_KEYS: '[]' },
    { ...ok, ETCITO_GAME_KEYS: '{}' },
    { ...ok, ETCITO_GAME_KEYS: JSON.stringify({ g: 'not_a_gsk_key' }) },
    { ...ok, ETCITO_GAME_KEYS: JSON.stringify({ g: 42 }) },
    { ...ok, ETCITO_GAME_KEYS: JSON.stringify({ a: KEY_A, b: KEY_A }) },
  ]
  for (const env of bad) {
    assert.throws(() => loadStoreConfig(env), (e: Error) => {
      assert.match(e.message, /^\[config\] (PLAYER_STORE|ETCITO_URL|ETCITO_GAME_KEYS)/)
      assert.ok(!e.message.includes('gsk_secret'), e.message)
      assert.ok(!e.message.includes('pw@'), e.message)
      return true
    })
  }
})

// --- game parameters -------------------------------------------------------------------------

test('elo: default parameters keep the documented values; custom ones apply', () => {
  assert.equal(nextRating(2500, 2500, 1, 0, DEFAULT_ELO), 2580)
  assert.equal(nextRating(2500, 2700, 1, 20), 2524)
  assert.equal(nextRating(2700, 2500, 0, 20), 2676)
  const custom = { start: 1000, kFloor: 20, placementGames: 2 }
  assert.equal(kFactor(1, custom), 160)
  assert.equal(kFactor(2, custom), 128)
  assert.equal(kFactor(20, custom), 20)
})

test('parseGameRow validates and never echoes the row', () => {
  assert.deepEqual(parseGameRow(gameRow('g', { queues: ['ranked'], elo_start: '1200' })), { elo: { start: 1200, kFloor: 32, placementGames: 5 }, queues: ['ranked'] })
  for (const over of [{ elo_start: -1 }, { elo_k_floor: 0 }, { placement_games: 1.5 }, { queues: '[]' }, { queues: '["blitz"]' }, { queues: 'nope' }]) {
    assert.throws(() => parseGameRow(gameRow('g', over)), /etc_game\./)
  }
})

test('settings: read at start, refreshed, previous values kept on failure or invalid row', async () => {
  const api = await tenant('game-a', { elo_start: 1800 })
  const logs: string[] = []
  const s = createGameSettings(api, { game: 'game-a', log: (l, m) => logs.push(m) })
  assert.deepEqual(s.current(), DEFAULT_GAME_PARAMS)
  assert.equal(await s.refresh(), 'ok')
  assert.equal(s.current().elo.start, 1800)
  const row = api.rows('etc_game')[0]!
  await api.update('etc_game', row.id as number, { elo_start: 1900, queues: '["quick"]' })
  assert.equal(await s.refresh(), 'ok')
  assert.deepEqual(s.current(), { elo: { start: 1900, kFloor: 32, placementGames: 5 }, queues: ['quick'] })
  await api.update('etc_game', row.id as number, { elo_k_floor: 'abc' })
  assert.equal(await s.refresh(), 'invalid')
  assert.equal(s.current().elo.start, 1900)
  const down: TableApi = { ...api, query: () => Promise.reject(new Error('db down')) }
  const s2 = createGameSettings(down, { game: 'game-a', log: (l, m) => logs.push(m) })
  assert.equal(await s2.refresh(), 'failed')
  assert.deepEqual(s2.current(), DEFAULT_GAME_PARAMS)
  assert.equal(await createGameSettings(createMemoryTableApi(), { game: 'x' }).refresh(), 'no_row')
  assert.equal(await createGameSettings(api, { game: 'other' }).refresh(), 'mismatch')
})

test('settings: the timer refreshes on its own', async () => {
  const api = await tenant('game-a')
  const s = createGameSettings(api, { game: 'game-a', intervalMs: 10 })
  await s.refresh()
  s.start()
  await api.update('etc_game', api.rows('etc_game')[0]!.id as number, { elo_start: 1111 })
  for (let i = 0; i < 100 && s.current().elo.start !== 1111; i++) await new Promise(r => setTimeout(r, 10))
  s.stop()
  assert.equal(s.current().elo.start, 1111)
})

test('router: a key reading another mission is refused at start-up', async () => {
  await assert.rejects(createGameRouter({ 'game-a': await tenant('game-b') }), /game "game-a"/)
})

test('router: a refreshed elo_start applies to new players without a restart', async () => {
  const api = await tenant('game-a', { elo_start: 1500 })
  const router = await createGameRouter({ 'game-a': api }, { intervalMs: 5 })
  const store = router.resolve('game-a')!.store
  const { player } = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'x' })
  assert.equal((await store.getRating(player.player_id, 'game-a')).rating, 1500)
  await api.update('etc_game', api.rows('etc_game')[0]!.id as number, { elo_start: 1700 })
  for (let i = 0; i < 100 && (await store.getRating(player.player_id, 'game-a')).rating !== 1700; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal((await store.getRating(player.player_id, 'game-a')).rating, 1700)
  router.close()
})

// --- several games ---------------------------------------------------------------------------

function service(router: ConstructorParameters<typeof MatchService>[1], hooks: HandshakeHooks = {}) {
  const logs: string[] = []
  const deps = { now: () => 1_000_000, random: Math.random, log: (l: string, m: string) => { logs.push(`${l} ${m}`) } }
  const svc = new MatchService(deps, router, hooks)
  const hub = new RelayHub(deps, svc)
  svc.attach(hub)
  const add = () => {
    const sent: Record<string, unknown>[] = []
    const id = hub.connect({ send: (t: string) => { sent.push(JSON.parse(t)) }, close() {} }, '/')
    return { sent, last: () => sent.at(-1), frame: (m: Record<string, unknown>) => hub.message(id, JSON.stringify(m)) }
  }
  return { add, logs }
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }
const TOKEN = 'same-guest-token-abcdefgh'

test('two games: the same external id is two unrelated players, with separate ratings', async () => {
  const apiA = await tenant('game-a', { elo_start: 1000 }), apiB = await tenant('game-b', { elo_start: 3000 })
  const router = await createGameRouter({ 'game-a': apiA, 'game-b': apiB })
  const sa = router.resolve('game-a')!.store, sb = router.resolve('game-b')!.store
  const ident = { provider: 'wavedash' as const, external_id: 'wd-42' }
  const pa = (await sa.getOrCreateByIdentity(ident, { display_name: 'Alice' })).player
  const pb = (await sb.getOrCreateByIdentity(ident, { display_name: 'Bob' })).player
  assert.notEqual(pa.player_id, pb.player_id)
  assert.equal(apiA.rows('etc_players').length, 1)
  assert.equal(apiB.rows('etc_players').length, 1)
  assert.equal(await sa.getPlayer(pb.player_id), null)
  assert.equal((await sa.getRating(pa.player_id, 'game-a')).rating, 1000)
  assert.equal((await sb.getRating(pb.player_id, 'game-b')).rating, 3000)
  router.close()
})

test('two games through the socket: auth picks the store of its game; unknown game and mismatches are refused', async () => {
  const apiA = await tenant('game-a'), apiB = await tenant('game-b', { queues: '["quick"]' })
  const router = await createGameRouter({ 'game-a': apiA, 'game-b': apiB })
  const s = service(router)
  const a = s.add(), b = s.add(), c = s.add(), d = s.add()
  a.frame({ t: 'auth', provider: 'guest', token: TOKEN, game: 'game-a' })
  b.frame({ t: 'auth', provider: 'guest', token: TOKEN, game: 'game-b' })
  c.frame({ t: 'auth', provider: 'guest', token: TOKEN, game: 'no-such-game' })
  d.frame({ t: 'auth', provider: 'guest', token: TOKEN }) // several games: the game is required
  await flush()
  assert.equal(a.last()!.t, 'authed')
  assert.equal(b.last()!.t, 'authed')
  assert.notEqual(a.last()!.player_id, b.last()!.player_id)
  assert.deepEqual(c.last(), { t: 'error', reason: 'bad_message' })
  assert.deepEqual(d.last(), { t: 'error', reason: 'bad_message' })
  assert.equal(apiA.rows('etc_players').length, 1)
  assert.equal(apiB.rows('etc_players').length, 1)
  // queue on the wrong game, and on a queue the game does not offer
  a.frame({ t: 'match_queue', game: 'game-b', queue: 'quick' })
  b.frame({ t: 'match_queue', game: 'game-b', queue: 'ranked' })
  await flush()
  assert.deepEqual(a.last(), { t: 'error', reason: 'bad_message' })
  assert.deepEqual(b.last(), { t: 'error', reason: 'bad_queue' })
  b.frame({ t: 'match_queue', game: 'game-b', queue: 'quick' })
  await flush()
  assert.equal(b.last()!.t, 'match_queued')
  router.close()
})

test('one game configured: auth without a game uses it', async () => {
  const router = await createGameRouter({ 'game-a': await tenant('game-a') })
  const a = service(router).add()
  a.frame({ t: 'auth', provider: 'guest', token: TOKEN })
  await flush()
  assert.equal(a.last()!.t, 'authed')
  router.close()
})

test('two games: a ranked match is rated in the store of its own game only', async () => {
  const apiA = await tenant('game-a'), apiB = await tenant('game-b')
  const router = await createGameRouter({ 'game-a': apiA, 'game-b': apiB })
  const s = service(router)
  const p = [s.add(), s.add()]
  const other = s.add()
  for (const [i, c] of [...p, other].entries()) c.frame({ t: 'auth', provider: 'guest', token: `${TOKEN}-${i}`, game: c === other ? 'game-b' : 'game-a' })
  await flush()
  for (const c of [...p, other]) c.frame({ t: 'match_queue', game: c === other ? 'game-b' : 'game-a', queue: 'ranked' })
  await flush()
  const id = p[0]!.sent.find(m => m.t === 'match')!.match_id
  for (const [c, outcome] of [[p[0]!, 'win'], [p[1]!, 'loss']] as const) c.frame({ t: 'result', match_id: id, outcome })
  await flush()
  assert.equal(apiA.rows('etc_rating_events').length, 2)
  assert.equal(apiB.rows('etc_rating_events').length, 0)
  assert.equal(apiA.rows('etc_ranked_results').length, 1)
  router.close()
})

// --- keys and logs ---------------------------------------------------------------------------

test('openStores routes each game with its own key, and nothing logs a key', async () => {
  const apis = new Map<string, TableApi>([[KEY_A, await tenant('game-a')], [KEY_B, await tenant('game-b')]])
  const seenAuth = new Set<string>()
  const failing = new Set<string>()
  const fake = (async (url: string, init: RequestInit) => {
    const key = new Headers(init.headers).get('authorization')!.slice('Bearer '.length)
    seenAuth.add(key)
    const api = apis.get(key)!
    const m = /\/api\/tables\/([^/]+)(\/query|\/(\d+))?$/.exec(url)!
    const body = init.body ? JSON.parse(init.body as string) : {}
    if (failing.has(key)) return new Response(`boom ${key}`, { status: 500 })
    if (m[2] === '/query') return new Response(JSON.stringify({ records: await api.query(m[1]!, body) }))
    if (init.method === 'PATCH') { await api.update(m[1]!, Number(m[3]), body); return new Response('{}') }
    const r = await api.insert(m[1]!, body)
    return r === 'conflict' ? new Response('dup', { status: 409 }) : new Response(JSON.stringify(r.row))
  }) as unknown as typeof fetch
  const logs: string[] = []
  const log = (l: string, m: string) => { logs.push(`${l} ${m}`) }
  const stores = await openStores(loadStoreConfig({ PLAYER_STORE: 'http', ETCITO_URL: URL_T, ETCITO_GAME_KEYS: JSON.stringify({ 'game-a': KEY_A, 'game-b': KEY_B }) }), { fetch: fake, log })
  const s = service(stores)
  const a = s.add(), b = s.add()
  a.frame({ t: 'auth', provider: 'guest', token: TOKEN, game: 'game-a' })
  b.frame({ t: 'auth', provider: 'guest', token: TOKEN, game: 'game-b' })
  await flush()
  assert.notEqual(a.last()!.player_id, b.last()!.player_id)
  assert.deepEqual(seenAuth, new Set([KEY_A, KEY_B]))
  assert.equal((await apis.get(KEY_A)!.query('etc_players', {})).length, 1)
  // a failing tenant: store_unavailable on the socket, and no key in any log line
  failing.add(KEY_A)
  const c = s.add()
  c.frame({ t: 'auth', provider: 'guest', token: `${TOKEN}-2`, game: 'game-a' })
  await flush()
  assert.deepEqual(c.last(), { t: 'error', reason: 'store_unavailable' })
  const stores2 = await openStores(loadStoreConfig({ PLAYER_STORE: 'http', ETCITO_URL: URL_T, ETCITO_GAME_KEYS: JSON.stringify({ 'game-a': KEY_A }) }), { fetch: fake, log })
  assert.deepEqual(stores2.resolve('game-a')!.queues(), DEFAULT_GAME_PARAMS.queues) // read failed: defaults
  for (const line of [...logs, ...s.logs]) assert.ok(!line.includes('gsk_'), line)
  stores.close(); stores2.close()
})

// --- identity verification -------------------------------------------------------------------

test('identity: guest is verified; wavedash and itch fail closed with auth_unavailable', async () => {
  const router = await createGameRouter({ 'game-a': await tenant('game-a') })
  const s = service(router, { verifyIdentity: verifyIdentityHook() })
  const g = s.add(), w = s.add(), i = s.add()
  g.frame({ t: 'auth', provider: 'guest', token: TOKEN })
  w.frame({ t: 'auth', provider: 'wavedash', token: 'any-token' })
  i.frame({ t: 'auth', provider: 'itch', token: 'any-token' })
  await flush()
  assert.equal(g.last()!.t, 'authed')
  assert.deepEqual(w.last(), { t: 'error', reason: 'auth_unavailable' })
  assert.deepEqual(i.last(), { t: 'error', reason: 'auth_unavailable' })
  assert.ok(s.logs.some(l => l.includes('provider non configure: wavedash')))
  router.close()
})

test('identity: an injected verifier decides, receives the game, and cannot answer for another provider', async () => {
  const seen: (string | undefined)[] = []
  const hook = verifyIdentityHook(defaultVerifiers({
    wavedash: { async verify(token, name, game) { seen.push(game); return token === 'ok' ? { provider: 'wavedash', external_id: 'wd-1', display_name: 'Wd' } : null } },
    itch: { async verify() { return { provider: 'guest', external_id: 'x', display_name: 'Eve' } } },
  }))
  assert.equal((await hook('wavedash', 'ok', undefined, 'game-a'))?.external_id, 'wd-1')
  assert.equal(await hook('wavedash', 'bad'), null)
  assert.equal(await hook('itch', 't'), null)
  assert.deepEqual(seen, ['game-a', undefined])
})
