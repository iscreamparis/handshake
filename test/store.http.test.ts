import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { playerStoreContract } from '../src/store/contract.ts'
import { createHttpPlayerStore } from '../src/store/http.ts'
import { createCrmTableApi, createMemoryTableApi } from '../src/store/tables.ts'

playerStoreContract('http store (fake tenant)', () => createHttpPlayerStore(createMemoryTableApi()))

describe('http store specifics', () => {
  test('parallel debits never overdraw and each tx id applies once', async () => {
    const store = createHttpPlayerStore(createMemoryTableApi())
    const { player } = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'g-concurrent' })
    await store.credit(player.player_id, 100, 'seed', 'seed-1')
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => store.debit(player.player_id, 30, 'buy', `d-${i}`)))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 3)
    assert.equal(await store.balance(player.player_id), 10)
  })
  test('parallel same-tx credit applies once', async () => {
    const store = createHttpPlayerStore(createMemoryTableApi())
    const { player } = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'g-same-tx' })
    const rs = await Promise.all([1, 2, 3].map(() => store.credit(player.player_id, 50, 'r', 'same')))
    assert.equal(rs.filter(r => r.applied).length, 1)
    assert.equal(await store.balance(player.player_id), 50)
  })
  test('two ranked locks for one player: only one match wins; unlock frees it', async () => {
    const store = createHttpPlayerStore(createMemoryTableApi())
    const { player } = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'g-lock' })
    const [x, y] = await Promise.all([store.lockRanked(player.player_id, 'm1'), store.lockRanked(player.player_id, 'm2')])
    assert.equal([x, y].filter(Boolean).length, 1)
    const won = x ? 'm1' : 'm2'
    assert.equal((await store.getPlayer(player.player_id))?.active_ranked_match, won)
    assert.equal(await store.unlockRanked(player.player_id, won), true)
    assert.equal(await store.lockRanked(player.player_id, 'm3'), true)
  })
  test('same identity resolved in parallel yields one player', async () => {
    const store = createHttpPlayerStore(createMemoryTableApi())
    const rs = await Promise.all([1, 2, 3].map(() => store.getOrCreateByIdentity({ provider: 'wavedash', external_id: 'wd-1' })))
    assert.equal(new Set(rs.map(r => r.player.player_id)).size, 1)
    assert.equal(rs.filter(r => r.created).length, 1)
  })
})

describe('CRM table client', () => {
  test('maps 409 to conflict, sends the service key and parses query envelopes', async () => {
    const calls: { url: string; method: string; auth: string | null }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), auth: new Headers(init.headers).get('authorization') })
      if (url.endsWith('/etc_ledger')) return new Response('dup', { status: 409 })
      if (url.endsWith('/query')) return new Response(JSON.stringify({ records: [{ id: 1, a: 2 }] }))
      return new Response('{}')
    }) as unknown as typeof fetch
    const api = createCrmTableApi({ baseUrl: 'https://t.example/', apiKey: 'gsk_x', fetch: fake })
    assert.equal(await api.insert('etc_ledger', { tx_id: 't' }), 'conflict')
    assert.deepEqual(await api.query('etc_players', { filters: [{ field: 'player_id', op: 'eq', value: 'p' }] }), [{ id: 1, a: 2 }])
    await api.update('etc_locks', 7, { open_key: null })
    assert.equal(calls[0]!.auth, 'Bearer gsk_x')
    assert.equal(calls[2]!.url, 'https://t.example/api/tables/etc_locks/7')
    assert.equal(calls[2]!.method, 'PATCH')
  })
})
