import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublisher, PublisherError } from '../src/publisher/runner.ts'
import { economyRoutes } from '../src/economy/routes.ts'
import type { GameBackend } from '../src/store/games.ts'
import type { EconomyService } from '../src/economy/service.ts'
import { createGameRouter } from '../src/store/games.ts'
import { createMemoryTableApi } from '../src/store/tables.ts'
import { RoomHub } from '../src/hub.ts'
import { loadConfig } from '../src/config.ts'

const event = (type: string, object: object) => ({ type, data: { object } })

test('per-game Stripe verifies with the selected bridge, refuses cross-game metadata, and scopes refunds', async () => {
  const calls: string[] = []
  const svc = (game: string): EconomyService => ({
    hasStripe: () => true,
    stripeVerify: async (_raw: string, sig: string) => { calls.push(`${game}:${sig}`); return sig === game ? event('checkout.session.completed', { metadata: { game } }) : null },
    stripeCompleted: async () => ({ status: 'granted' }),
    stripeRefunded: async () => { calls.push(`refund:${game}`); return true },
    wavedashGameIds: async () => [],
  }) as unknown as EconomyService
  const a = svc('a'), b = svc('b')
  const backends = (): GameBackend[] => [{ game: 'a', store: {} as GameBackend['store'], queues: () => ['quick'], economy: a }, { game: 'b', store: {} as GameBackend['store'], queues: () => ['quick'], economy: b }]
  const route = economyRoutes({ backends }).find(r => r.path === '/webhooks/stripe/:game')!
  const send = (game: string, sig: string) => route.handle({ body: '{}', headers: { 'stripe-signature': sig }, params: { game } })
  assert.equal((await send('b', 'b')).status, 200)
  assert.deepEqual(calls, ['b:b'])
  assert.equal((await send('b', 'a')).status, 400)
  const originalVerify = b.stripeVerify
  b.stripeVerify = async () => event('checkout.session.completed', { metadata: { game: 'a' } })
  assert.equal((await send('b', 'b')).status, 400)
  b.stripeVerify = originalVerify
  assert.equal((await send('missing', 'missing')).status, 404)
  const refund = economyRoutes({ backends }).find(r => r.path === '/webhooks/stripe/:game')!
  const old = b.stripeVerify
  b.stripeVerify = async () => event('charge.refunded', { refunded: true, payment_intent: 'pi_x' })
  assert.equal((await refund.handle({ body: '{}', headers: { 'stripe-signature': 'b' }, params: { game: 'b' } })).status, 200)
  assert.ok(calls.includes('refund:b'))
  assert.ok(!calls.includes('refund:a'))
  b.stripeVerify = old
})

test('Wavedash audience with duplicate publisher IDs fails closed', async () => {
  const svc = { wavedashGameIds: async () => ['same-aud'] } as EconomyService
  const backends = (): GameBackend[] => ['a', 'b'].map(game => ({ game, store: {} as GameBackend['store'], queues: () => ['quick'], economy: svc }))
  const route = economyRoutes({ backends }).find(r => r.path === '/webhooks/wavedash')!
  const jwt = `e30.${Buffer.from(JSON.stringify({ aud: 'same-aud' })).toString('base64url')}.x`
  const res = await route.handle({ body: JSON.stringify({ receiptJwt: jwt }), headers: {} })
  assert.deepEqual(res, { status: 400, body: { error: 'ambiguous_game' } })
})

test('Wavedash audience copied by a creator still reaches the owner game (the owner wins)', async () => {
  const hits: string[] = []
  const svc = (game: string) => ({
    wavedashGameIds: async () => ['owner-aud'],
    wavedashFromWebhook: async () => { hits.push(game); return { status: 'granted' } },
  }) as unknown as EconomyService
  const backends = (): GameBackend[] => ['creator', 'kekkai'].map(game => ({ game, store: {} as GameBackend['store'], queues: () => ['quick'], economy: svc(game) }))
  const route = economyRoutes({ backends }).find(r => r.path === '/webhooks/wavedash')!
  const jwt = `e30.${Buffer.from(JSON.stringify({ aud: 'owner-aud' })).toString('base64url')}.x`
  const res = await route.handle({ body: JSON.stringify({ receiptJwt: jwt }), headers: {} })
  assert.deepEqual(res, { status: 200, body: { ok: true, status: 'granted' } })
  assert.deepEqual(hits, ['kekkai'])
})

test('game settings default to ten rooms, can only be lowered by the creator, and owner games stay unlimited', async () => {
  const api = createMemoryTableApi()
  await api.insert('etc_game', { code: 'new', handshake_game: 'new', elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]' })
  const router = await createGameRouter({ new: api }, { multiCreator: true })
  assert.equal(router.resolve('new')?.maxRooms?.(), 10)
  await api.insert('etc_settings', { key: 'limits.max_rooms', value: '3' })
  const row = router.resolve('new')!
  assert.equal(row.maxRooms?.(), 10)
  router.close()
  const refreshed = await createGameRouter({ new: api }, { multiCreator: true })
  assert.equal(refreshed.resolve('new')?.maxRooms?.(), 3)
  refreshed.close()
  // The creator writes its own etc_settings: a value above the platform ceiling is clamped.
  await api.update('etc_settings', api.rows('etc_settings')[0]!.id as number, { value: '5000' })
  const raised = await createGameRouter({ new: api }, { multiCreator: true })
  assert.equal(raised.resolve('new')?.maxRooms?.(), 10)
  raised.close()
  const owner = createMemoryTableApi()
  await owner.insert('etc_game', { code: 'kekkai', handshake_game: 'kekkai', elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]' })
  const legacy = await createGameRouter({ kekkai: owner }, { multiCreator: true })
  assert.equal(legacy.resolve('kekkai')?.maxRooms, undefined)
  legacy.close()
})

test('single-owner mode (no key file) keeps today\'s behaviour for every game: no caps, blank handshake_game accepted', async () => {
  const api = createMemoryTableApi()
  await api.insert('etc_game', { code: 'other', handshake_game: '', elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]' })
  const router = await createGameRouter({ other: api, kekkai: api })
  try {
    assert.ok(router.resolve('other'))
    assert.equal(router.resolve('other')?.maxRooms, undefined)
    assert.deepEqual(router.backends().map(b => b.game), ['other', 'kekkai'])
    // An unknown game still opens rooms (no strictGames) and has no per-game cap.
    assert.equal((router as { strictGames?: boolean }).strictGames, undefined)
  } finally { router.close() }
})

test('room hub enforces game cap without affecting other games', () => {
  const hub = new RoomHub(loadConfig({}), { now: () => Date.now(), random: Math.random, seed: () => 1, log: () => {} })
  hub.gameKnown = game => game === 'new' || game === 'kekkai'
  hub.maxRoomsForGame = game => game === 'new' ? 1 : undefined
  const client = (game: string) => {
    const sent: any[] = []
    const id = hub.connect({ send: text => sent.push(JSON.parse(text)), close: () => {} })
    hub.message(id, JSON.stringify({ t: 'hello', v: 1, game, name: 'Ann' }))
    hub.message(id, JSON.stringify({ t: 'create', players: [{ name: 'Ann', build: { characterId: 'kit', bodyId: 'std', wheelId: 'std', gliderId: 'std' } }] }))
    return sent.at(-1)
  }
  assert.equal(client('new').t, 'room')
  assert.equal(client('new').code, 'server_full')
  assert.equal(client('kekkai').t, 'room')
  const unknown: any[] = []
  const unknownId = hub.connect({ send: text => unknown.push(JSON.parse(text)), close: () => {} })
  hub.message(unknownId, JSON.stringify({ t: 'hello', v: 1, game: 'unknown', name: 'Ann' }))
  assert.deepEqual([unknown.at(-1).code, unknown.at(-1).message], ['bad_message', 'unknown game'])
})

test('publisher uses isolated HOME/tmp, redacts CLI output, requires tokens, and caps pending runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'publisher-isolation-'))
  try {
    const bin = join(dir, 'fake-wavedash')
    await writeFile(bin, '#!/bin/sh\necho "$HOME|$TMPDIR|$WAVEDASH_TOKEN"\necho "X-Wavedash-Token: $WAVEDASH_TOKEN"\nsleep 0.2\nexit 0\n')
    await chmod(bin, 0o755)
    const publisher = createPublisher({ dataDir: dir, home: join(dir, 'shared-home'), wavedashBin: bin, maxArtifactBytes: 1000, keepArtifacts: 2, runTimeoutMs: 5000, maxQueuedRuns: 2 })
    const req = (game: string) => ({ game, game_id: 'gameid1234', action: 'publish' as const, build_id: 'build1234' })
    await assert.rejects(publisher.startRun(req('a')), (e: unknown) => e instanceof PublisherError && e.status === 409)
    const a = await publisher.startRun(req('a'), 'secret-token-a')
    const b = await publisher.startRun(req('b'), 'secret-token-b')
    await assert.rejects(publisher.startRun(req('c'), 'secret-token-c'), (e: unknown) => e instanceof PublisherError && e.status === 429)
    await publisher.idle()
    const logA = (await publisher.getRun(a.id))!.log, logB = (await publisher.getRun(b.id))!.log
    assert.match(logA, /\/home\|.*\/tmp\|\[REDACTED\]/)
    assert.ok(!logA.includes('secret-token-a') && !logA.includes('secret-token-b'))
    assert.ok(!logB.includes('secret-token-a') && !logB.includes('secret-token-b'))
    assert.ok(!logA.includes('shared-home'))
    assert.notEqual(logA.split('|')[0], logB.split('|')[0])
    assert.equal((await readFile(join(dir, 'runs', `${a.id}.json`), 'utf8')).includes('secret-token-a'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('publisher: owner games keep the service HOME and the stored login (no token needed), are mirrored, and logs stream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'publisher-owner-'))
  try {
    const bin = join(dir, 'fake-wavedash')
    await writeFile(bin, '#!/bin/sh\necho "home=$HOME tmp=${TMPDIR:-unset} tok=${WAVEDASH_TOKEN:-none}"\nsleep 0.4\necho done\nexit 0\n')
    await chmod(bin, 0o755)
    const tenant = createMemoryTableApi()
    const shared = join(dir, 'shared-home')
    const publisher = createPublisher({ dataDir: dir, home: shared, wavedashBin: bin, maxArtifactBytes: 1000, keepArtifacts: 2, runTimeoutMs: 5000, recorder: tenant })
    const req = (game: string) => ({ game, game_id: 'gameid1234', action: 'publish' as const, build_id: 'build1234' })
    const owner = await publisher.startRun(req('kekkai'))
    // The first line is in the log while the CLI is still running (the backoffice polls it).
    let live = ''
    for (let i = 0; i < 40 && !live.includes('home='); i++) { await new Promise(r => setTimeout(r, 20)); live = (await publisher.getRun(owner.id))!.log }
    assert.equal((await publisher.getRun(owner.id))!.status, 'running')
    assert.match(live, new RegExp(`home=${shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} tmp=unset tok=none`))
    await publisher.idle()
    const creator = await publisher.startRun(req('creator-game'), 'creator-token-1')
    await publisher.idle()
    assert.equal((await publisher.getRun(creator.id))!.status, 'ok')
    assert.ok(!(await publisher.getRun(creator.id))!.log.includes(shared))
    // Only the owner run reaches etc_deploy_runs (the recorder key reads the owner's mission).
    assert.deepEqual(tenant.rows('etc_deploy_runs').map(r => r.game), ['kekkai'])
    // A creator never falls back to the stored login.
    await assert.rejects(publisher.startRun(req('creator-game')), (e: unknown) => e instanceof PublisherError && e.status === 409)
    // A creator slug cannot borrow an owner's static game id.
    const withMap = createPublisher({ dataDir: dir, home: shared, wavedashBin: bin, maxArtifactBytes: 1000, keepArtifacts: 2, runTimeoutMs: 5000, games: { other: { name: 'X', game_id: 'gameid9999' } } })
    await assert.rejects(withMap.startRun({ game: 'other', action: 'publish', build_id: 'build1234' }, 'creator-token-1'), /unknown game/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('handshake wires unknown-game refusal only for a multi-creator store', async () => {
  const { createHandshake } = await import('../src/handshake.ts')
  const backend = { game: 'kekkai', store: {} as GameBackend['store'], queues: () => ['quick'] as const }
  const plain = createHandshake({ store: { resolve: (g?: string) => (g === 'kekkai' ? backend : null) } as never })
  assert.equal(plain.hub.gameKnown, undefined)
  const strict = createHandshake({ store: { strictGames: true, resolve: (g?: string) => (g === 'kekkai' ? backend : null) } as never })
  assert.equal(strict.hub.gameKnown?.('kekkai'), true)
  assert.equal(strict.hub.gameKnown?.('other'), false)
  assert.equal(strict.hub.maxRoomsForGame?.('kekkai'), undefined)
})

test('key registry picks up new games and rotated keys without restart; invalid updates keep the last good registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'game-registry-'))
  try {
    const file = join(dir, 'keys.json')
    const keyA = 'gsk_key_a_12345678', keyB = 'gsk_key_b_12345678', keyA2 = 'gsk_key_a_rotated_12345678'
    await writeFile(file, JSON.stringify({ a: keyA }))
    const fake = (async (url: string, init: RequestInit) => {
      const key = new Headers(init.headers).get('authorization')!.slice(7)
      const game = key === keyB ? 'b' : key === keyA || key === keyA2 ? 'a' : 'unknown'
      const table = /\/api\/tables\/([^/]+)/.exec(url)?.[1]
      const records = table === 'etc_game' && game !== 'unknown'
        ? [{ code: game, handshake_game: game, elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]' }] : []
      return new Response(JSON.stringify({ records }))
    }) as unknown as typeof fetch
    const { openStores } = await import('../src/store/setup.ts')
    const { loadStoreConfig } = await import('../src/store/config.ts')
    const stores = await openStores(loadStoreConfig({ PLAYER_STORE: 'http', ETCITO_URL: 'https://crm.example', ETCITO_GAME_KEYS_FILE: file }), { fetch: fake, registryIntervalMs: 15 })
    const settle = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 15)) }
    try {
      assert.equal(stores.strictGames, true)
      const a1 = stores.resolve('a')
      assert.ok(a1)
      assert.equal(stores.resolve('b'), null)
      await writeFile(file, '{invalid')
      await new Promise(r => setTimeout(r, 60))
      assert.equal(stores.resolve('a'), a1)
      // Adding b leaves a's backend (locks, caches, listeners) untouched.
      await writeFile(file, JSON.stringify({ a: keyA, b: keyB }))
      await settle(() => stores.resolve('b') !== null)
      assert.ok(stores.resolve('b'))
      assert.equal(stores.resolve('a'), a1)
      // Rotating a's key rebuilds a alone.
      const b1 = stores.resolve('b')
      await writeFile(file, JSON.stringify({ a: keyA2, b: keyB }))
      await settle(() => stores.resolve('a') !== a1)
      assert.notEqual(stores.resolve('a'), a1)
      assert.ok(stores.resolve('a'))
      assert.equal(stores.resolve('b'), b1)
      // Removing a closes it; unknown names stay refused.
      await writeFile(file, JSON.stringify({ b: keyB }))
      await settle(() => stores.resolve('a') === null)
      assert.equal(stores.resolve('a'), null)
      assert.deepEqual(stores.backends().map(x => x.game), ['b'])
      assert.equal(stores.resolve('unknown'), null)
    } finally { stores.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a refreshed mission mismatch disables only its game', async () => {
  const make = async (game: string) => {
    const api = createMemoryTableApi()
    await api.insert('etc_game', { code: game, handshake_game: game, elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]' })
    return api
  }
  const a = await make('a'), b = await make('b')
  const router = await createGameRouter({ a, b }, { intervalMs: 10, multiCreator: true })
  try {
    await a.update('etc_game', a.rows('etc_game')[0]!.id as number, { handshake_game: 'b' })
    for (let i = 0; i < 50 && router.resolve('a'); i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(router.resolve('a'), null)
    assert.ok(router.resolve('b'))
    assert.deepEqual(router.backends().map(x => x.game), ['b'])
  } finally { router.close() }
})

test('creator settings cannot raise save/UGC limits or catalog payload over platform caps', async () => {
  const api = createMemoryTableApi()
  for (const [key, value] of [['saves.quota_bytes', '999999999'], ['ugc.quota_bytes', '999999999'], ['ugc.writes_per_minute', '999999999']]) {
    await api.insert('etc_settings', { key, value })
  }
  const { createLimits } = await import('../src/online/limits.ts')
  const limits = await createLimits(api, () => 0, 0, { savesQuotaBytes: 10, ugcQuotaBytes: 40, ugcWritesPerMinute: 5 }).current()
  assert.equal(limits.savesQuotaBytes, 10)
  assert.equal(limits.ugcQuotaBytes, 40)
  assert.equal(limits.ugcWritesPerMinute, 5)
  const { createCatalog } = await import('../src/economy/catalog.ts')
  await api.insert('etc_settings', { key: 'economy.catalog', value: JSON.stringify({ cards: [{ id: 'card1', rarity: 'common' }] }) })
  const catalog = createCatalog(api, { game: 'creator', maxBytes: 10 })
  assert.equal(await catalog.refresh(), 'invalid')
  assert.deepEqual(catalog.current().cards, [])
})

test('Stripe bridge verification uses the selected mission service key without sending a new selector', async () => {
  const { createStripeBridge } = await import('../src/economy/stripe.ts')
  const requests: Array<{ url: string; auth: string; body: unknown }> = []
  const fake = (async (url: string, init: RequestInit) => {
    requests.push({ url, auth: new Headers(init.headers).get('authorization')!, body: JSON.parse(init.body as string) })
    return new Response(JSON.stringify({ valid: true, event: { type: 'ignored' } }))
  }) as unknown as typeof fetch
  const bridge = createStripeBridge({ baseUrl: 'https://crm.example', apiKey: 'gsk_creator', fetch: fake })
  assert.equal((await bridge.verify('raw-body', 'signature'))?.type, 'ignored')
  assert.deepEqual(requests, [{ url: 'https://crm.example/api/etcito-publisher/stripe/verify', auth: 'Bearer gsk_creator', body: { payload: 'raw-body', signature: 'signature' } }])
})

test('creator key cannot attach to a mission with a blank handshake_game', async () => {
  const api = createMemoryTableApi()
  await api.insert('etc_game', { code: 'other', handshake_game: '', elo_start: 2500, elo_k_floor: 32, placement_games: 5, queues: '["quick"]' })
  const router = await createGameRouter({ creator: api }, { multiCreator: true })
  assert.equal(router.resolve('creator'), null)
  router.close()
})

test('legacy Stripe endpoint checks both owner secrets and never verifies a creator key', async () => {
  const seen: string[] = []
  const backend = (game: string): GameBackend => ({ game, store: {} as GameBackend['store'], queues: () => ['quick'],
    economy: { hasStripe: () => true,
      stripeVerify: async (_body: string, sig: string) => {
        seen.push(game)
        return sig === game ? event('checkout.session.completed', { metadata: { game } }) : null
      }, stripeCompleted: async () => ({ status: 'granted' }),
    } as unknown as EconomyService,
  })
  const route = economyRoutes({ backends: () => [backend('kekkai'), backend('monsterracer'), backend('creator')] }).find(r => r.path === '/webhooks/stripe')!
  assert.equal((await route.handle({ body: '{}', headers: { 'stripe-signature': 'monsterracer' } })).status, 200)
  assert.deepEqual(seen, ['kekkai', 'monsterracer'])
  seen.length = 0
  assert.equal((await route.handle({ body: '{}', headers: { 'stripe-signature': 'creator' } })).status, 400)
  assert.deepEqual(seen, ['kekkai', 'monsterracer'])
})
