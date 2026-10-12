import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { StoreError } from './errors.ts'
import { nextRating, tierOf } from './elo.ts'
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
    const promiseCases: Array<[string, (store: PlayerStore) => Promise<unknown>, StoreError['code'] | 'none' | 'resolve']> = [
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
    test('credit is idempotent and updates the balance', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'wallet')
      assert.deepEqual(await store.credit(id, 10, 'reward', 't1'), { balance: 10, applied: true })
      assert.deepEqual(await store.credit(id, 10, 'reward', 't1'), { balance: 10, applied: false })
      assert.equal(await store.balance(id), 10)
    })

    test('wallet transaction ids conflict on amount, operation or player', async () => {
      const store = await makeStore()
      const a = await newPlayer(store, 'a')
      const b = await newPlayer(store, 'b')
      await store.credit(a.player_id, 10, 'reward', 't1')
      await rejectsWith(store.credit(a.player_id, 11, 'reward', 't1'), 'tx_conflict')
      await rejectsWith(store.debit(a.player_id, 10, 'reward', 't1'), 'tx_conflict')
      await rejectsWith(store.credit(b.player_id, 10, 'reward', 't1'), 'tx_conflict')
      assert.equal(await store.balance(a.player_id), 10)
      assert.equal(await store.balance(b.player_id), 0)
    })

    test('insufficient funds leave the balance and transaction id available', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'wallet')
      await store.credit(id, 10, 'reward', 'credit')
      await rejectsWith(store.debit(id, 11, 'purchase', 'debit'), 'insufficient_funds')
      assert.equal(await store.balance(id), 10)
      assert.deepEqual(await store.debit(id, 4, 'purchase', 'debit'), { balance: 6, applied: true })
      assert.equal(await store.balance(id), 6)
    })

    test('wallet validates amounts, transaction ids and reasons', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'wallet')
      await store.credit(id, 10, 'reward', 'seed')
      for (const operation of ['credit', 'debit'] as const) {
        for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          await rejectsWith(store[operation](id, amount, 'reason', `${operation}-${amount}`), 'bad_argument')
        }
        for (const txId of ['', 't'.repeat(129)]) {
          await rejectsWith(store[operation](id, 1, 'reason', txId), 'bad_argument')
        }
        for (const reason of ['', 'r'.repeat(65)]) {
          await rejectsWith(store[operation](id, 1, reason, `${operation}-reason-${reason.length}`), 'bad_argument')
        }
      }
      assert.equal(await store.balance(id), 10)
    })

    test('twenty concurrent credits sum exactly to 210', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'wallet')
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.credit(id, i + 1, 'reward', `credit-${i}`)))
      assert.equal(await store.balance(id), 210)
    })

    test('packs are added idempotently and share the wallet transaction namespace', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'packs')
      assert.deepEqual(await store.addPacks(id, 'game', 3, 'reward', 'packs'), { unopened: 3, applied: true })
      assert.deepEqual(await store.addPacks(id, 'game', 3, 'reward', 'packs'), { unopened: 3, applied: false })
      await rejectsWith(store.addPacks(id, 'game', 0, 'reward', 'zero'), 'bad_argument')
      await store.credit(id, 1, 'reward', 'credit')
      await rejectsWith(store.addPacks(id, 'game', 1, 'reward', 'credit'), 'tx_conflict')
      assert.equal(await store.unopenedPacks(id, 'game'), 3)
    })

    test('opening without packs rejects with no_packs', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'packs')
      await rejectsWith(store.openPack(id, 'game', () => ['a'], 'open'), 'no_packs')
      assert.equal(await store.unopenedPacks(id, 'game'), 0)
      assert.deepEqual(await store.collection(id, 'game'), {})
    })

    test('opening a pack rolls once and adds every card to the collection', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'packs')
      const n = 3
      await store.addPacks(id, 'game', n, 'reward', 'packs')
      let calls = 0
      const result = await store.openPack(id, 'game', (playerId, game) => {
        calls++
        assert.equal(playerId, id)
        assert.equal(game, 'game')
        return ['a', 'b', 'a']
      }, 'open')
      assert.equal(calls, 1)
      assert.deepEqual(result, { cards: ['a', 'b', 'a'], remaining: n - 1, applied: true })
      assert.equal(await store.unopenedPacks(id, 'game'), n - 1)
      assert.deepEqual(await store.collection(id, 'game'), { a: 2, b: 1 })
    })

    test('repeated open returns the original cards without rolling or consuming packs', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'packs')
      await store.addPacks(id, 'game', 2, 'reward', 'packs')
      let calls = 0
      const roller = () => { calls++; return ['a', 'b', 'a'] }
      const first = await store.openPack(id, 'game', roller, 'open')
      const repeated = await store.openPack(id, 'game', roller, 'open')
      assert.equal(calls, 1)
      assert.equal(first.applied, true)
      assert.deepEqual(repeated, { ...first, applied: false })
      assert.equal(await store.unopenedPacks(id, 'game'), 1)
      assert.deepEqual(await store.collection(id, 'game'), { a: 2, b: 1 })
    })

    test('a throwing roller propagates its own error without changing state', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'packs')
      await store.addPacks(id, 'game', 2, 'reward', 'packs')
      await store.openPack(id, 'game', () => ['existing'], 'seed')
      const error = new Error('roller failed')
      await assert.rejects(store.openPack(id, 'game', () => { throw error }, 'open'),
        (caught: unknown) => caught === error && !(caught instanceof StoreError))
      assert.equal(await store.unopenedPacks(id, 'game'), 1)
      assert.deepEqual(await store.collection(id, 'game'), { existing: 1 })
    })

    test('invalid roller output leaves state unchanged and async rollers work', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'packs')
      await store.addPacks(id, 'game', 2, 'reward', 'packs')
      await store.openPack(id, 'game', () => ['existing'], 'seed')
      const outputs = [[], Array.from({ length: 65 }, () => 'a'), ['']]
      for (const [i, cards] of outputs.entries()) {
        await rejectsWith(store.openPack(id, 'game', () => cards, `invalid-${i}`), 'bad_argument')
        assert.equal(await store.unopenedPacks(id, 'game'), 1)
        assert.deepEqual(await store.collection(id, 'game'), { existing: 1 })
      }
      assert.deepEqual(await store.openPack(id, 'game', async () => ['async'], 'async'),
        { cards: ['async'], remaining: 0, applied: true })
      assert.equal(await store.unopenedPacks(id, 'game'), 0)
      assert.deepEqual(await store.collection(id, 'game'), { existing: 1, async: 1 })
    })

    test('collection counts accumulate and packs and collections are per game and player', async () => {
      const store = await makeStore()
      const { player_id: id } = await newPlayer(store, 'packs')
      const other = await newPlayer(store, 'other')
      await store.addPacks(id, 'game', 3, 'reward', 'packs')
      await store.openPack(id, 'game', () => ['a', 'b', 'a'], 'open-1')
      await store.openPack(id, 'game', () => ['b', 'c', 'a'], 'open-2')
      assert.deepEqual(await store.collection(id, 'game'), { a: 3, b: 2, c: 1 })
      assert.equal(await store.unopenedPacks(id, 'game'), 1)
      assert.equal(await store.unopenedPacks(id, 'g2'), 0)
      assert.deepEqual(await store.collection(id, 'g2'), {})
      assert.equal(await store.unopenedPacks(other.player_id, 'game'), 0)
      assert.deepEqual(await store.collection(other.player_id, 'game'), {})
    })

    test('leaderboard excludes placement players until their fifth game', async () => {
      const store = await makeStore()
      const a = await newPlayer(store, 'a')
      const b = await newPlayer(store, 'b')
      for (let i = 0; i < 4; i++) await play(store, a.player_id, b.player_id, 0.5, `m-${i}`)
      const before = await store.leaderboard('game', 1)
      assert.equal(before.total, 0)
      assert.deepEqual(before.entries, [])
      await play(store, a.player_id, b.player_id, 0.5, 'fifth')
      const after = await store.leaderboard('game', 1)
      assert.equal(after.total, 2)
      assert.deepEqual(after.entries.map(entry => entry.player_id).sort(), [a.player_id, b.player_id].sort())
      assert.equal((await store.leaderboard('g2', 1)).total, 0)
    })

    test('leaderboard orders by rating then player id with ranks, tiers and residents', async () => {
      const store = await makeStore()
      const high = await newPlayer(store, 'high')
      const low = await newPlayer(store, 'low')
      const tieA = await newPlayer(store, 'tie-a')
      const tieB = (await store.getOrCreateByIdentity(
        { provider: 'guest', external_id: 'tie-b' }, { kind: 'resident', display_name: 'Resident' })).player
      for (let i = 0; i < 5; i++) {
        await play(store, high.player_id, low.player_id, 1, `win-${i}`)
        await play(store, tieA.player_id, tieB.player_id, 0.5, `draw-${i}`)
      }
      const tied = [tieA, tieB].sort((a, b) => a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0)
      const expectedPlayers = [high, ...tied, low]
      const page = await store.leaderboard('game', 1)
      assert.equal(page.game, 'game')
      assert.equal(page.page, 1)
      assert.equal(page.page_size, 50)
      assert.equal(page.total, 4)
      assert.equal(page.entries.length, 4)
      assert.equal(page.entries[1].rating, page.entries[2].rating)
      assert.ok(page.entries[0].rating > page.entries[1].rating)
      assert.ok(page.entries[2].rating > page.entries[3].rating)
      for (const [i, player] of expectedPlayers.entries()) {
        const rating = await store.getRating(player.player_id, 'game')
        assert.deepEqual(page.entries[i], {
          rank: i + 1, player_id: player.player_id, display_name: player.display_name,
          rating: rating.rating, games: rating.games, tier: tierOf(rating.rating),
        })
      }
    })

    test('leaderboard pages past the end preserve total and invalid pages reject', async () => {
      const store = await makeStore()
      const a = await newPlayer(store, 'a')
      const b = await newPlayer(store, 'b')
      for (let i = 0; i < 5; i++) await play(store, a.player_id, b.player_id, 0.5, `m-${i}`)
      const first = await store.leaderboard('game', 1)
      assert.equal(first.total, 2)
      assert.equal(first.entries.length, first.total)
      assert.equal(first.page_size, 50)
      const second = await store.leaderboard('game', 2)
      assert.deepEqual(second, { game: 'game', page: 2, page_size: 50, total: first.total, entries: [] })
      await rejectsWith(store.leaderboard('game', 1.5), 'bad_argument')
      await rejectsWith(store.leaderboard('game', 0), 'bad_argument')
    })

    test('returned objects and input identities are detached from store state', async () => {
      const store = await makeStore()
      const identity = { provider: 'guest' as const, external_id: 'original' }
      const created = await store.getOrCreateByIdentity(identity, { display_name: 'Alice' })
      const id = created.player.player_id
      identity.external_id = 'mutated-input'
      const original = await store.getPlayer(id)
      assert.ok(original)
      assert.deepEqual(original.identities, [{ provider: 'guest', external_id: 'original' }])
      assert.equal((await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'original' })).player.player_id, id)
      created.player.display_name = 'Changed'
      created.player.identities.push({ provider: 'guest', external_id: 'extra' })
      created.player.identities[0].external_id = 'mutated-output'
      created.player.active_ranked_match = 'fake-lock'
      assert.deepEqual(await store.getPlayer(id), original)
      const returnedPlayer = await store.getPlayer(id)
      assert.ok(returnedPlayer)
      returnedPlayer.display_name = 'Changed again'
      returnedPlayer.identities.push({ provider: 'guest', external_id: 'extra-again' })
      returnedPlayer.identities[0].external_id = 'changed-again'
      returnedPlayer.active_ranked_match = 'another-fake-lock'
      assert.deepEqual(await store.getPlayer(id), original)

      const opponent = await newPlayer(store, 'opponent')
      for (let i = 0; i < 5; i++) await play(store, id, opponent.player_id, 0.5, `m-${i}`)
      const rating = await store.getRating(id, 'game')
      const expectedRating = { ...rating }
      rating.game = 'changed'
      rating.rating = 0
      rating.games = 999
      rating.placement = true
      assert.deepEqual(await store.getRating(id, 'game'), expectedRating)

      await store.addPacks(id, 'game', 1, 'reward', 'packs')
      await store.openPack(id, 'game', () => ['a'], 'open')
      const collection = await store.collection(id, 'game')
      collection.a = 999
      collection.extra = 1
      assert.deepEqual(await store.collection(id, 'game'), { a: 1 })

      const page = await store.leaderboard('game', 1)
      const expectedEntries = page.entries.map(entry => ({ ...entry }))
      Object.assign(page.entries[0], {
        rank: 999, player_id: 'changed', display_name: 'Changed', rating: 0, games: 999, tier: 'Bronze',
      })
      assert.deepEqual((await store.leaderboard('game', 1)).entries, expectedEntries)
    })
  })
}
