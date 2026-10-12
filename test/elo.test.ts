import test from 'node:test'
import assert from 'node:assert/strict'
import { displayRating, expectedScore, kFactor, nextRating, tierOf } from '../src/store/elo.ts'
import { StoreError } from '../src/store/errors.ts'

test('nextRating matches the worked examples exactly', () => {
  assert.equal(nextRating(2500, 2500, 1, 0), 2580)
  assert.equal(nextRating(2500, 2500, 0, 0), 2420)
  assert.equal(nextRating(2500, 2700, 1, 20), 2524)
  assert.equal(nextRating(2700, 2500, 0, 20), 2676)
  assert.equal(nextRating(10, 10, 0, 20), 0)
})

test('kFactor uses placement and established-player values', () => {
  assert.equal(kFactor(0), 160)
  assert.equal(kFactor(4), 160)
  assert.equal(kFactor(5), 80)
  assert.equal(kFactor(6), 64)
  assert.equal(kFactor(8), 32)
  assert.equal(kFactor(20), 32)
})

test('expectedScore for equal ratings is one half', () => {
  assert.equal(expectedScore(2500, 2500), 0.5)
})

test('tierOf returns each rating band', () => {
  assert.equal(tierOf(0), 'Bronze')
  assert.equal(tierOf(1599), 'Bronze')
  assert.equal(tierOf(1600), 'Gold')
  assert.equal(tierOf(2199), 'Gold')
  assert.equal(tierOf(2200), 'Platinum')
  assert.equal(tierOf(2799), 'Platinum')
  assert.equal(tierOf(2800), 'Diamond')
  assert.equal(tierOf(3399), 'Diamond')
  assert.equal(tierOf(3400), 'Master')
})

test('displayRating hides placement and low ratings', () => {
  assert.equal(displayRating(499, false), '< 500')
  assert.equal(displayRating(500, false), '500')
  assert.equal(displayRating(2500, true), null)
})

test('StoreError exposes its code and name', () => {
  const error = new StoreError('not_found', 'x')
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'not_found')
  assert.equal(error.name, 'StoreError')
})
