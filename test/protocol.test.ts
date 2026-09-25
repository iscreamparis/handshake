import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseClientMessage, validatePlayers, validateSettings, encode,
  ERROR_CODES, DEFAULT_SETTINGS, MAX_MESSAGE_BYTES,
} from '../src/protocol.ts'
import type { ErrorCode } from '../src/protocol.ts'

const build = { characterId: 'rex', bodyId: 'kart-1', wheelId: 'std', gliderId: 'wing' }
const player = (name = 'Ann') => ({ name, build: { ...build } })
const settings = { kind: 'track', cupId: 'sprout', trackId: 'meadow-loop', cc: 100, items: false }

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m))
function code(m: unknown, raw = false): ErrorCode | undefined {
  const r = raw ? parseClientMessage(m as string) : parse(m)
  return 'error' in r ? r.error : undefined
}

test('valid parse of every client message type', () => {
  assert.deepEqual(parse({ t: 'hello', v: 1, game: 'build-1', name: 'Ann', extra: 1 }), { t: 'hello', v: 1, game: 'build-1', name: 'Ann' })
  assert.deepEqual(parse({ t: 'create', players: [player()] }), { t: 'create', players: [player()] })
  assert.deepEqual(parse({ t: 'create', players: [player(), player('Bo')], settings }), { t: 'create', players: [player(), player('Bo')], settings })
  assert.deepEqual(parse({ t: 'join', code: 'abcde', players: [player()] }), { t: 'join', code: 'abcde', players: [player()] })
  assert.deepEqual(parse({ t: 'leave' }), { t: 'leave' })
  assert.deepEqual(parse({ t: 'players', players: [player()] }), { t: 'players', players: [player()] })
  assert.deepEqual(parse({ t: 'settings', settings }), { t: 'settings', settings })
  assert.deepEqual(parse({ t: 'start' }), { t: 'start' })
  assert.deepEqual(parse({ t: 'end' }), { t: 'end' })
  for (const data of [
    { kind: 'offer', sdp: 'v=0' },
    { kind: 'answer', sdp: 'v=0' },
    { kind: 'ice', candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
    { kind: 'ice', candidate: '', sdpMid: null, sdpMLineIndex: null },
    { kind: 'ice-end' },
  ]) {
    assert.deepEqual(parse({ t: 'signal', to: 3, data }), { t: 'signal', to: 3, data })
  }
  assert.deepEqual(parse({ t: 'ping', id: 7 }), { t: 'ping', id: 7 })
})

test('hello keeps v as given, non-number v is bad_message', () => {
  assert.deepEqual(parse({ t: 'hello', v: 2, game: 'g', name: 'A' }), { t: 'hello', v: 2, game: 'g', name: 'A' })
  assert.equal(code({ t: 'hello', v: '1', game: 'g', name: 'A' }), 'bad_message')
  assert.equal(code({ t: 'hello', v: 1, game: '', name: 'A' }), 'bad_message')
  assert.equal(code({ t: 'hello', v: 1, game: 'g'.repeat(65), name: 'A' }), 'bad_message')
})

test('too_large and bad_message basics', () => {
  const big = JSON.stringify({ t: 'ping', id: 1, pad: 'x'.repeat(MAX_MESSAGE_BYTES) })
  assert.equal(code(big, true), 'too_large')
  assert.equal(code('{not json', true), 'bad_message')
  assert.equal(code('[1,2]', true), 'bad_message')
  assert.equal(code('42', true), 'bad_message')
  assert.equal(code({ t: 'nope' }), 'bad_message')
  assert.equal(code({ id: 1 }), 'bad_message')
  assert.equal(code({ t: 'ping' }), 'bad_message')
  assert.equal(code({ t: 'join', players: [player()] }), 'bad_message')
  assert.equal(code({ t: 'create' }), 'bad_message')
  assert.equal(code({ t: 'signal', to: 8, data: { kind: 'ice-end' } }), 'bad_message')
})

test('bad_players', () => {
  assert.equal(code({ t: 'create', players: [] }), 'bad_players')
  assert.equal(code({ t: 'join', code: 'ABCDE', players: [1, 2, 3, 4, 5].map(i => player('P' + i)) }), 'bad_players')
  assert.equal(code({ t: 'players', players: [player('   ')] }), 'bad_players')
  assert.equal(code({ t: 'players', players: [player('a'.repeat(17))] }), 'bad_players')
  assert.equal(code({ t: 'create', players: [{ name: 'A', build: { ...build, bodyId: 'Kart' } }] }), 'bad_players')
  assert.equal(code({ t: 'create', players: [{ name: 'A', build: { ...build, wheelId: 'w'.repeat(25) } }] }), 'bad_players')
  assert.equal(validatePlayers([player()])?.length, 1)
})

test('bad_settings', () => {
  const p = [player()]
  assert.equal(code({ t: 'create', players: p, settings: { ...settings, kind: 'race' } }), 'bad_settings')
  assert.equal(code({ t: 'settings', settings: { ...settings, cc: 125 } }), 'bad_settings')
  assert.equal(code({ t: 'settings', settings: { ...settings, items: 'yes' } }), 'bad_settings')
  assert.equal(code({ t: 'settings', settings: { ...settings, trackId: 'Bad Id' } }), 'bad_settings')
})

test('bad signal data is bad_message', () => {
  assert.equal(code({ t: 'signal', to: 1, data: { kind: 'hello' } }), 'bad_message')
  assert.equal(code({ t: 'signal', to: 1, data: { kind: 'offer' } }), 'bad_message')
  assert.equal(code({ t: 'signal', to: 1, data: { kind: 'offer', sdp: 'x'.repeat(16400) } }), 'bad_message')
})

test('rid is echoed in errors and replies', () => {
  assert.deepEqual(parse({ t: 'nope', rid: 'r1' }), { error: 'bad_message', rid: 'r1', message: "unknown type 'nope'" })
  const r = parse({ t: 'create', rid: 9, players: [] })
  assert.ok('error' in r && r.error === 'bad_players' && r.rid === 9)
  assert.deepEqual(parse({ t: 'start', rid: 4 }), { t: 'start', rid: 4 })
  assert.deepEqual(parse({ t: 'start', rid: {} }), { t: 'start' })
})

test('names are trimmed', () => {
  assert.deepEqual(parse({ t: 'hello', v: 1, game: 'g', name: '  Ann  ' }), { t: 'hello', v: 1, game: 'g', name: 'Ann' })
  const r = parse({ t: 'players', players: [player(' ' + 'b'.repeat(16) + ' ')] })
  assert.ok(!('error' in r) && r.t === 'players' && r.players[0].name === 'b'.repeat(16))
})

test('error codes, defaults and encode', () => {
  assert.equal(ERROR_CODES.length, 17)
  assert.equal(new Set(ERROR_CODES).size, 17)
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS)
  assert.equal(encode({ t: 'pong', id: 3 }), '{"t":"pong","id":3}')
})
