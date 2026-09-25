import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROOM_CODE_ALPHABET, generateRoomCode, normalizeRoomCode } from '../src/codes.ts'

function seq(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

test('alphabet: 32 unique chars without I, O, 0 or 1', () => {
  assert.equal(ROOM_CODE_ALPHABET.length, 32)
  assert.equal(new Set(ROOM_CODE_ALPHABET).size, 32)
  for (const bad of ['I', 'O', '0', '1']) assert.ok(!ROOM_CODE_ALPHABET.includes(bad), bad)
})

test('codes are 5 chars from the alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode(Math.random, () => false)
    assert.equal(code.length, 5)
    for (const ch of code) assert.ok(ROOM_CODE_ALPHABET.includes(ch), ch)
  }
  assert.equal(generateRoomCode(() => 0, () => false), 'AAAAA')
  assert.equal(generateRoomCode(() => 0.999999, () => false), '99999')
})

test('generation retries while the code is taken', () => {
  const seen: string[] = []
  const code = generateRoomCode(seq([0, 0, 0, 0, 0, 1 / 32, 1 / 32, 1 / 32, 1 / 32, 1 / 32]), (c) => {
    seen.push(c)
    return c === 'AAAAA'
  })
  assert.deepEqual(seen, ['AAAAA', 'BBBBB'])
  assert.equal(code, 'BBBBB')
})

test('generation throws exhausted when every code is taken', () => {
  let calls = 0
  assert.throws(() => generateRoomCode(Math.random, () => { calls++; return true }), { message: '[codes] exhausted' })
  assert.equal(calls, 100)
})

test('normalization', () => {
  assert.equal(normalizeRoomCode(' abcde '), 'ABCDE')
  assert.equal(normalizeRoomCode('XYZ23'), 'XYZ23')
  assert.equal(normalizeRoomCode('ABCD'), null)
  assert.equal(normalizeRoomCode('ABCDEF'), null)
  assert.equal(normalizeRoomCode(''), null)
  assert.equal(normalizeRoomCode('ABCDO'), null)
  assert.equal(normalizeRoomCode('ABCD0'), null)
  assert.equal(normalizeRoomCode('ABCDI'), null)
  assert.equal(normalizeRoomCode('ABCD1'), null)
  assert.equal(normalizeRoomCode('AB-DE'), null)
  assert.equal(normalizeRoomCode('AB DE'), null)
})
