import { test } from 'node:test'
import assert from 'node:assert/strict'
import { playerStoreContract } from '../src/store/contract.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { StoreError } from '../src/store/errors.ts'
import { nextRating } from '../src/store/elo.ts'

playerStoreContract('memory store', () => createMemoryStore())

async function setupPacks(count: number) {
  const store = createMemoryStore()
  const { player } = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'packs' })
  await store.addPacks(player.player_id, 'game', count, 'reward', 'packs')
  return { store, id: player.player_id }
}

function deferredCards() {
  let resolve!: (cards: string[]) => void
  const promise = new Promise<string[]>(done => { resolve = done })
  return { promise, resolve }
}

test('memory store uses injected time and UUID', async () => {
  const store = createMemoryStore({ now: () => 1234, uuid: () => 'abcd-id' })
  const { player } = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'a' })
  assert.equal(player.player_id, 'abcd-id')
  assert.equal(player.created_at, 1234)
  assert.equal(player.display_name, 'Player-abcd')
})

test('an awaiting open rechecks the pack count and leaves its transaction available', async () => {
  const { store, id } = await setupPacks(1)
  const pending = deferredCards()
  const slow = store.openPack(id, 'game', () => pending.promise, 'slow')
  await store.openPack(id, 'game', () => ['fast'], 'fast')
  pending.resolve(['slow'])
  await assert.rejects(slow, (error: unknown) => error instanceof StoreError && error.code === 'no_packs')
  assert.equal(await store.unopenedPacks(id, 'game'), 0)
  assert.deepEqual(await store.collection(id, 'game'), { fast: 1 })
  await store.addPacks(id, 'game', 1, 'reward', 'refill')
  assert.equal((await store.openPack(id, 'game', () => ['slow'], 'slow')).applied, true)
})

test('an awaiting open rechecks its transaction and returns the first committed result', async () => {
  const { store, id } = await setupPacks(2)
  const pending = deferredCards()
  const slow = store.openPack(id, 'game', () => pending.promise, 'same')
  const first = await store.openPack(id, 'game', () => ['first'], 'same')
  pending.resolve(['second'])
  assert.deepEqual(await slow, { ...first, applied: false })
  assert.equal(await store.unopenedPacks(id, 'game'), 1)
  assert.deepEqual(await store.collection(id, 'game'), { first: 1 })
})

test('an awaiting open detects a transaction used by another economy operation', async () => {
  const { store, id } = await setupPacks(1)
  const pending = deferredCards()
  const slow = store.openPack(id, 'game', () => pending.promise, 'shared')
  await store.credit(id, 1, 'reward', 'shared')
  pending.resolve(['card'])
  await assert.rejects(slow, (error: unknown) => error instanceof StoreError && error.code === 'tx_conflict')
  assert.equal(await store.unopenedPacks(id, 'game'), 1)
  assert.deepEqual(await store.collection(id, 'game'), {})
  assert.equal(await store.balance(id), 1)
})

test('economy results and roller card arrays are detached from stored transactions', async () => {
  const { store, id } = await setupPacks(1)
  const cards = ['__proto__', 'constructor', '__proto__']
  const opened = await store.openPack(id, 'game', () => cards, 'open')
  cards[0] = 'changed-input'
  opened.cards[0] = 'changed-output'
  opened.remaining = 999
  const repeated = await store.openPack(id, 'game', () => { assert.fail('repeated open rolled') }, 'open')
  assert.deepEqual(repeated, { cards: ['__proto__', 'constructor', '__proto__'], remaining: 0, applied: false })
  repeated.cards.push('extra')
  assert.equal((await store.openPack(id, 'game', () => [], 'open')).cards.length, 3)
  assert.deepEqual(await store.collection(id, 'game'), { ['__proto__']: 2, constructor: 1 })
  const credited = await store.credit(id, 10, 'reward', 'credit')
  credited.balance = 999
  assert.deepEqual(await store.credit(id, 10, 'reward', 'credit'), { balance: 10, applied: false })
  const added = await store.addPacks(id, 'game', 2, 'reward', 'more')
  added.unopened = 999
  assert.deepEqual(await store.addPacks(id, 'game', 2, 'reward', 'more'), { unopened: 2, applied: false })
})

test('ranked results use each players own prior game count and return detached copies', async () => {
  const store = createMemoryStore()
  const a = (await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'a' })).player.player_id
  const b = (await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'b' })).player.player_id
  const c = (await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'c' })).player.player_id
  for (let i = 0; i < 6; i++) {
    await store.applyRankedResult({ match_id: `setup-${i}`, game: 'game', a, b: c, score_a: 0.5 })
  }
  await store.lockRanked(a, 'other')
  const outcome = { match_id: 'unequal-games', game: 'game', a, b, score_a: 1 as const }
  const result = await store.applyRankedResult(outcome)
  assert.equal(result.a.after, nextRating(2500, 2500, 1, 6))
  assert.equal(result.b.after, nextRating(2500, 2500, 0, 0))
  assert.equal(result.a.games, 7)
  assert.equal(result.b.games, 1)
  assert.equal((await store.getPlayer(a))?.active_ranked_match, 'other')
  const expected = structuredClone(result)
  result.a.after = 0
  outcome.game = 'mutated'
  const repeated = await store.applyRankedResult({ ...outcome, game: 'game' })
  assert.deepEqual(repeated, { ...expected, applied: false })
  repeated.b.games = 999
  assert.deepEqual(await store.applyRankedResult({ ...outcome, game: 'game' }), { ...expected, applied: false })
})
