import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { StoreError } from './errors.ts'
import { nextRating } from './elo.ts'
import type { PlayerStore } from './types.ts'

type StoreFactory = () => PlayerStore | Promise<PlayerStore>

async function rejectsWith(p: Promise<unknown>, code: StoreError['code']): Promise<void> {
  assert.ok(p instanceof Promise)
  await assert.rejects(p, (error: unknown) => error instanceof StoreError && error.code === code)
}

async function newPlayer(store: PlayerStore, id: string) {
  return (await store.getOrCreateByIdentity({ provider: 'guest', external_id: id })).player
}

async function play(store: PlayerStore, a: string, b: string, score: 0 | 0.5 | 1, matchId: string) {
  return store.applyRankedResult({ match_id: matchId, game: 'game', a, b, score_a: score })
}

export function playerStoreContract(label: string, makeStore: StoreFactory): void {
  describe(label, () => {
    const promiseCases: Array<[string, (store: PlayerStore) => Promise<unknown>, StoreError['code']]> = [
      ['getOrCreateByIdentity', s => s.getOrCreateByIdentity({ provider: 'guest', external_id: '' }), 'bad_argument'],
      ['getPlayer', s => s.getPlayer('unknown'), 'none'],
      ['getRating', s => s.getRating('unknown', 'game'), 'not_found'],
      ['applyRankedResult', s => s.applyRankedResult({ match_id: 'm', game: 'game', a: 'unknown-a', b: 'unknown-b', score_a: 1 }), 'not_found'],
      ['lockRanked', s => s.lockRanked('unknown', 'm'), 'resolve'],
      ['unlockRanked', s => s.unlockRanked('unknown', 'm'), 'resolve'],
      ['balance', s => s.balance('unknown'), 'not_found'],
      ['credit', s => s.credit('unknown', 1, 'reason', 'tx'), 'not_found'],
      ['debit', s => s.debit('unknown', 1, 'reason', 'tx'), 'not_found'],
      ['unopenedPacks', s => s.unopenedPacks('unknown', 'game'), 'not_found'],
      ['addPacks', s => s.addPacks('unknown', 'game', 1, 'reason', 'tx'), 'not_found'],
      ['openPack', s => s.openPack('unknown', 'game', () => ['card'], 'tx'), 'not_found'],
      ['collection', s => s.collection('unknown', 'game'), 'not_found'],
      ['leaderboard', s => s.leaderboard('game', 0), 'bad_argument'],
    ]

    for (const [method, call, expected] of promiseCases) {
      test(`${method} returns a Promise`, async () => {
        const store = await makeStore()
        let promise: Promise<unknown>
        try {
          promise = call(store)
        } catch (error) {
          assert.fail(`${method} threw synchronously: ${String(error)}`)
        }
        assert.ok(promise! instanceof Promise)
        if (expected === 'resolve') {
          await promise!
        } else if (expected === 'none') {
          assert.equal(await promise!, null)
        } else {
          await rejectsWith(promise!, expected)
        }
      })
    }

    test('identity is stable and ignores later initialization', async () => {
      const store = await makeStore()
      const first = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'same' }, { display_name: 'Alice' })
      const second = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'same' }, { display_name: 'Robert', kind: 'resident' })
      assert.equal(first.created, true)
      assert.equal(second.created, false)
      assert.equal(first.player.player_id, second.player.player_id)
      assert.equal(second.player.display_name, 'Alice')
      assert.equal(second.player.kind, 'human')
    })

    test('new player has UUID id and default human kind; resident kind is kept', async () => {
      const store = await makeStore()
      const human = await newPlayer(store, 'human')
      const resident = (await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'resident' }, { kind: 'resident' })).player
      assert.match(human.player_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      assert.equal(human.kind, 'human')
      assert.equal(resident.kind, 'resident')
    })

    test('display_name is trimmed and invalid lengths use the player fallback', async () => {
      const store = await makeStore()
      const alice = (await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'alice' }, { display_name: '  Alice  ' })).player
      assert.equal(alice.display_name, 'Alice')
      for (const [id, displayName] of [['short', 'ab'], ['long', '12345678901234567']]) {
        const p = (await store.getOrCreateByIdentity({ provider: 'guest', external_id: id }, { display_name: displayName })).player
        assert.equal(p.display_name, `Player-${p.player_id.slice(0, 4)}`)
      }
    })

    test('external_id accepts 256 chars and rejects 257', async () => {
      const store = await makeStore()
      await rejectsWith(store.getOrCreateByIdentity({ provider: 'guest', external_id: 'x'.repeat(257) }), 'bad_argument')
      const result = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'x'.repeat(256) })
      assert.equal(result.created, true)
    })

    test('getPlayer returns null for an unknown id', async () => {
      const store = await makeStore()
      assert.equal(await store.getPlayer('unknown'), null)
    })

    test('default rating is in placement', async () => {
      const store = await makeStore()
      const player = await newPlayer(store, 'rating')
      assert.deepEqual(await store.getRating(player.player_id, 'game'), { game: 'game', rating: 2500, games: 0, placement: true })
    })

    test('ranked result applies the placement ELO example', async () => {
      const store = await makeStore()
      const a = await newPlayer(store, 'a')
      const b = await newPlayer(store, 'b')
      const result = await play(store, a.player_id, b.player_id, 1, 'm1')
      assert.deepEqual([result.a.before, result.a.after, result.b.before, result.b.after], [2500, 2580, 2500, 2420])
      assert.equal(result.a.games, 1)
      assert.equal(result.b.games, 1)
      assert.equal(result.a.placement, true)
      assert.equal(result.b.placement, true)
    })

    test('post-placement result uses elastic K through the store', async () => {
      const store = await makeStore()
      const a = await newPlayer(store, 'a')
      const b = await newPlayer(store, 'b')
      for (let i = 0; i < 20; i++) await play(store, a.player_id, b.player_id, i % 2 === 0 ? 1 : 0, `setup-${i}`)
      const beforeA = await store.getRating(a.player_id, 'game')
      const beforeB = await store.getRating(b.player_id, 'game')
      const score: 0 | 0.5 | 1 = 1
      const result = await play(store, a.player_id, b.player_id, score, 'after-setup')
      assert.equal(result.a.after, nextRating(beforeA.rating, beforeB.rating, score, 20))
      assert.equal(result.b.after, nextRating(beforeB.rating, beforeA.rating, 0, 20))
      assert.equal(result.a.placement, false)
      assert.equal(result.b.placement, false)
    })

    test('ranked result is idempotent by match id', async () => {
      const store = await makeStore()
      const a = await newPlayer(store, 'a')
      const b = await newPlayer(store, 'b')
      const outcome = { match_id: 'repeat', game: 'game', a: a.player_id, b: b.player_id, score_a: 1 as const }
      const first = await store.applyRankedResult(outcome)
      const ratingA = await store.getRating(a.player_id, 'game')
      const ratingB = await store.getRating(b.player_id, 'game')
      const repeated = await store.applyRankedResult(outcome)
      assert.equal(first.applied, true)
      assert.equal(repeated.applied, false)
      assert.deepEqual({ ...repeated, applied: true }, first)
      assert.deepEqual(await store.getRating(a.player_id, 'game'), ratingA)
      assert.deepEqual(await store.getRating(b.player_id, 'game'), ratingB)
    })

    test('ranked result validates distinct existing players', async () => {
      const store = await makeStore()
      const a = await newPlayer(store, 'a')
      await rejectsWith(play(store, a.player_id, a.player_id, 1, 'same'), 'bad_argument')
      await rejectsWith(play(store, a.player_id, 'unknown', 1, 'missing'), 'not_found')
    })

    test('applying a result clears only matching ranked locks', async () => {
      const store = await makeStore()
      const a = await newPlayer(store, 'a')
      const b = await newPlayer(store, 'b')
      const c = await newPlayer(store, 'c')
      assert.equal(await store.lockRanked(a.player_id, 'm1'), true)
      assert.equal(await store.lockRanked(b.player_id, 'm1'), true)
      assert.equal(await store.lockRanked(c.player_id, 'other'), true)
      await play(store, a.player_id, b.player_id, 1, 'm1')
      assert.equal((await store.getPlayer(a.player_id))?.active_ranked_match, null)
      assert.equal((await store.getPlayer(b.player_id))?.active_ranked_match, null)
      assert.equal((await store.getPlayer(c.player_id))?.active_ranked_match, 'other')
    })

    test('lockRanked accepts same match id and refuses a different one', async () => {
      const store = await makeStore()
      const player = await newPlayer(store, 'lock')
      assert.equal(await store.lockRanked(player.player_id, 'm1'), true)
      assert.equal(await store.lockRanked(player.player_id, 'm1'), true)
      assert.equal(await store.lockRanked(player.player_id, 'm2'), false)
    })

    test('unlockRanked requires the matching match id', async () => {
      const store = await makeStore()
      const player = await newPlayer(store, 'unlock')
      await store.lockRanked(player.player_id, 'm1')
      assert.equal(await store.unlockRanked(player.player_id, 'm2'), false)
      assert.equal((await store.getPlayer(player.player_id))?.active_ranked_match, 'm1')
      assert.equal(await store.unlockRanked(player.player_id, 'm1'), true)
      assert.equal((await store.getPlayer(player.player_id))?.active_ranked_match, null)
    })

    test('concurrent ranked locks have exactly one winner', async () => {
      const store = await makeStore()
      const player = await newPlayer(store, 'race')
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.lockRanked(player.player_id, `match-${i}`)))
      assert.equal(results.filter(Boolean).length, 1)
      const winner = results.findIndex(Boolean)
      assert.equal((await store.getPlayer(player.player_id))?.active_ranked_match, `match-${winner}`)
    })

    // part 2: wallet, packs, collection, leaderboard, copies
  })
}
