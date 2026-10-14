import test from 'node:test'
import assert from 'node:assert/strict'
import { Matchmaker, RESIDENT_AFTER_MS, rankedWindow } from '../src/match/matchmaker.ts'
import type { Waiter } from '../src/match/matchmaker.ts'

function waiter(conn: string, over: Partial<Omit<Waiter, 'conn'>> = {}): Waiter {
  return {
    conn,
    player_id: `player-${conn}`,
    game: 'g',
    queue: 'quick',
    rating: 2500,
    since: 0,
    ...over,
  }
}

test('ranked: the pairing window is 100 and grows by 100 every 5000 ms', () => {
  assert.equal(rankedWindow(0), 100)
  assert.equal(rankedWindow(4999), 100)
  assert.equal(rankedWindow(5000), 200)
  assert.equal(rankedWindow(15000), 400)
})

test('ranked: a 250 gap pairs at 10000 ms, not at 9999 ms', () => {
  const mm = new Matchmaker()
  mm.add(waiter('a', { queue: 'ranked', rating: 2500 }))
  mm.add(waiter('b', { queue: 'ranked', rating: 2750 }))
  assert.deepEqual(mm.pairs(9999), [])
  const pairs = mm.pairs(10000)
  assert.equal(pairs.length, 1)
  assert.deepEqual([pairs[0].a.conn, pairs[0].b.conn], ['a', 'b'])
  assert.equal(mm.get('a'), null)
  assert.equal(mm.get('b'), null)
  assert.equal(mm.size('g', 'ranked'), 0)
})

test('ranked: the candidate with the smallest rating gap wins', () => {
  const mm = new Matchmaker()
  mm.add(waiter('w', { queue: 'ranked', rating: 2500 }))
  mm.add(waiter('far', { queue: 'ranked', rating: 2600 }))
  mm.add(waiter('near', { queue: 'ranked', rating: 2540 }))
  const pairs = mm.pairs(0)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].a.conn, 'w')
  assert.equal(pairs[0].b.conn, 'near')
  assert.equal(mm.get('far')?.conn, 'far')
})

test('ranked: equal gaps go to the earlier since, then to insertion order', () => {
  const bySince = new Matchmaker()
  bySince.add(waiter('w', { queue: 'ranked', rating: 2500, since: 0 }))
  bySince.add(waiter('late', { queue: 'ranked', rating: 2600, since: 500 }))
  bySince.add(waiter('early', { queue: 'ranked', rating: 2400, since: 100 }))
  const first = bySince.pairs(500)
  assert.equal(first.length, 1)
  assert.equal(first[0].b.conn, 'early')

  const byInsertion = new Matchmaker()
  byInsertion.add(waiter('w', { queue: 'ranked', rating: 2500, since: 0 }))
  byInsertion.add(waiter('first', { queue: 'ranked', rating: 2600, since: 0 }))
  byInsertion.add(waiter('second', { queue: 'ranked', rating: 2400, since: 0 }))
  const second = byInsertion.pairs(0)
  assert.equal(second.length, 1)
  assert.equal(second[0].b.conn, 'first')
})

test('ranked: two waiters of the same player_id are never paired', () => {
  const mm = new Matchmaker()
  mm.add(waiter('a1', { queue: 'ranked', player_id: 'same' }))
  mm.add(waiter('a2', { queue: 'ranked', player_id: 'same' }))
  assert.deepEqual(mm.pairs(0), [])
  assert.equal(mm.size('g', 'ranked'), 2)
  mm.add(waiter('b', { queue: 'ranked', player_id: 'other', rating: 2550 }))
  const pairs = mm.pairs(0)
  assert.equal(pairs.length, 1)
  assert.deepEqual([pairs[0].a.conn, pairs[0].b.conn].sort(), ['a1', 'b'])
  assert.equal(mm.get('a2')?.conn, 'a2')
})

test('ranked: a waiter is due for a resident at 15000 ms and not at 14999 ms', () => {
  const mm = new Matchmaker()
  mm.add(waiter('a', { queue: 'ranked', since: 1000 }))
  mm.add(waiter('b', { queue: 'ranked', since: 1200 }))
  assert.deepEqual(mm.dueForResident(15999), [])
  assert.deepEqual(mm.dueForResident(16000).map((w) => w.conn), ['a'])
  assert.deepEqual(mm.dueForResident(16200).map((w) => w.conn), ['a', 'b'])
  assert.equal(mm.size('g', 'ranked'), 2)
  assert.equal(RESIDENT_AFTER_MS.ranked, 15000)
})

test('quick: waiters pair in arrival (FIFO) order', () => {
  const mm = new Matchmaker()
  mm.add(waiter('a'))
  mm.add(waiter('b'))
  mm.add(waiter('c'))
  const first = mm.pairs(0)
  assert.deepEqual(first.map((p) => [p.a.conn, p.b.conn]), [['a', 'b']])
  assert.equal(mm.get('c')?.conn, 'c')
  mm.add(waiter('d'))
  const pairs = mm.pairs(0)
  assert.deepEqual(pairs.map((p) => [p.a.conn, p.b.conn]), [['c', 'd']])
  assert.equal(mm.size('g', 'quick'), 0)
})

test('quick: queues are kept apart by game and by queue name', () => {
  const mm = new Matchmaker()
  mm.add(waiter('one-a', { game: 'one' }))
  mm.add(waiter('two-a', { game: 'two' }))
  mm.add(waiter('ranked-a', { queue: 'ranked' }))
  assert.deepEqual(mm.pairs(0), [])
  mm.add(waiter('one-b', { game: 'one' }))
  const pairs = mm.pairs(0)
  assert.equal(pairs.length, 1)
  assert.deepEqual([pairs[0].a.conn, pairs[0].b.conn], ['one-a', 'one-b'])
  assert.equal(pairs[0].game, 'one')
  assert.equal(pairs[0].queue, 'quick')
  assert.equal(mm.size('two', 'quick'), 1)
  assert.equal(mm.size('g', 'ranked'), 1)
})

test('quick: a waiter is due for a resident at 8000 ms and not at 7999 ms', () => {
  const mm = new Matchmaker()
  mm.add(waiter('a', { since: 1000 }))
  mm.add(waiter('b', { since: 1200 }))
  assert.deepEqual(mm.dueForResident(8999), [])
  assert.deepEqual(mm.dueForResident(9000).map((w) => w.conn), ['a'])
  assert.deepEqual(mm.dueForResident(9200).map((w) => w.conn), ['a', 'b'])
  assert.equal(mm.size('g', 'quick'), 2)
  assert.equal(RESIDENT_AFTER_MS.quick, 8000)
})

test('quick: add, get, remove and size keep the queue consistent', () => {
  const mm = new Matchmaker()
  const w = waiter('a', { game: 'one' })
  assert.equal(mm.add(w), true)
  assert.equal(mm.add(waiter('a')), false)
  assert.equal(mm.get('a'), w)
  assert.equal(mm.get('missing'), null)
  assert.equal(mm.size('one', 'quick'), 1)
  assert.equal(mm.size('two', 'quick'), 0)
  assert.equal(mm.remove('a'), w)
  assert.equal(mm.remove('a'), null)
  assert.equal(mm.get('a'), null)
  assert.equal(mm.size('one', 'quick'), 0)
})
