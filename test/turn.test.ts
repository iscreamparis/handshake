import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iceServersFor } from '../src/turn.ts'
import { loadConfig } from '../src/config.ts'
import { TokenBucket } from '../src/ratelimit.ts'

const withTurn = loadConfig({ TURN_SECRET: 'secret', TURN_URLS: 'turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349' })

test('turn: known HMAC vector', () => {
  const servers = iceServersFor('abc', withTurn, 1700000000)
  assert.equal(servers.length, 2)
  assert.deepEqual(servers[0], { urls: ['stun:stun.l.google.com:19302'] })
  assert.deepEqual(servers[1].urls, ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'])
  assert.equal(servers[1].username, '1700086400:abc')
  assert.equal(servers[1].credential, '0OrSUldgWXBwpUJwwothdtlrU8w=')
})

test('turn: expiry is nowSec + 86400 (floored)', () => {
  const servers = iceServersFor('xyz', withTurn, 1234.9)
  const [expiry, client] = (servers[1].username ?? '').split(':')
  assert.equal(Number(expiry), 1234 + 86400)
  assert.equal(client, 'xyz')
})

test('turn: no secret means no TURN entry', () => {
  const cfg = loadConfig({ TURN_URLS: 'turn:turn.example.com:3478' })
  assert.equal(cfg.turnSecret, null)
  assert.deepEqual(iceServersFor('abc', cfg, 1700000000), [{ urls: ['stun:stun.l.google.com:19302'] }])
  assert.equal(loadConfig({ TURN_SECRET: '', TURN_URLS: 'turn:x' }).turnSecret, null)
  assert.deepEqual(iceServersFor('abc', loadConfig({ STUN_URLS: '' }), 0), [])
})

test('config: defaults', () => {
  assert.deepEqual(loadConfig({}), {
    port: 8787,
    host: '127.0.0.1',
    stunUrls: ['stun:stun.l.google.com:19302'],
    turnUrls: [],
    turnSecret: null,
    maxRooms: 500,
    maxClients: 2000,
    allowedOrigins: [],
    logLevel: 'info',
  })
})

test('config: lists and numbers', () => {
  const cfg = loadConfig({
    PORT: '9000', HOST: '0.0.0.0', MAX_ROOMS: '0', MAX_CLIENTS: '10', LOG_LEVEL: 'debug',
    ALLOWED_ORIGINS: ' https://a.example , ,https://b.example,',
    STUN_URLS: 'stun:a:1,stun:b:2',
  })
  assert.equal(cfg.port, 9000)
  assert.equal(cfg.host, '0.0.0.0')
  assert.equal(cfg.maxRooms, 0)
  assert.equal(cfg.maxClients, 10)
  assert.equal(cfg.logLevel, 'debug')
  assert.deepEqual(cfg.allowedOrigins, ['https://a.example', 'https://b.example'])
  assert.deepEqual(cfg.stunUrls, ['stun:a:1', 'stun:b:2'])
})

test('config: invalid values throw', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), { message: '[config] PORT' })
  assert.throws(() => loadConfig({ PORT: '-1' }), { message: '[config] PORT' })
  assert.throws(() => loadConfig({ MAX_ROOMS: '1.5' }), { message: '[config] MAX_ROOMS' })
  assert.throws(() => loadConfig({ MAX_CLIENTS: '' }), { message: '[config] MAX_CLIENTS' })
  assert.throws(() => loadConfig({ LOG_LEVEL: 'warn' }), { message: '[config] LOG_LEVEL' })
})

test('ratelimit: burst, refusal and refill', () => {
  const bucket = new TokenBucket(40, 80)
  for (let i = 0; i < 80; i++) assert.equal(bucket.take(0), true, `take ${i}`)
  assert.equal(bucket.overSinceMs, null)
  assert.equal(bucket.take(0), false)
  assert.equal(bucket.overSinceMs, 0)
  assert.equal(bucket.take(10), false)
  assert.equal(bucket.overSinceMs, 0)
  assert.equal(bucket.take(100), true)
  assert.equal(bucket.overSinceMs, null)
})
