// End-to-end matchmaking tests over real sockets against createHandshake, on
// RELAY_PATH: one test per feature (auth, quick, ranked). Time only moves
// through the fake clock and handshake.tick; "nothing happened" is checked
// after a message round-trip, never after a real delay.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHandshake } from '../src/handshake.ts'
import type { Handshake } from '../src/handshake.ts'
import { RELAY_PATH } from '../src/relay/protocol.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { guestIdentity } from '../src/hooks.ts'
import type { ResidentSeat } from '../src/hooks.ts'

type Msg = Record<string, any>

let WsClient: any = null
try {
  WsClient = (await import('ws')).WebSocket
} catch {
  WsClient = null
}
const skip = WsClient === null ? 'ws not installed' : false

const clock = { t: 1_000_000 }
const store = createMemoryStore()
let server: Handshake | null = null
let port = 0
let residentId = ''
let picks = 0
const sinkGot: Msg[] = []
let released = 0
const sockets: any[] = []

before(async () => {
  if (skip) return
  const { player } = await store.getOrCreateByIdentity(
    { provider: 'guest', external_id: 'resident-1' },
    { kind: 'resident', display_name: 'Resident' },
  )
  residentId = player.player_id
  server = createHandshake({
    config: { port: 0, host: '127.0.0.1', logLevel: 'error' },
    deps: { now: () => clock.t },
    autoTick: false,
    store,
    hooks: {
      async verifyIdentity(provider, token, name) {
        if (provider === 'wavedash') {
          return token === 'wd-good-token' ? { provider: 'wavedash', external_id: 'wd-1', display_name: 'Wavey' } : null
        }
        if (provider === 'guest') return guestIdentity(token, name)
        return null
      },
      async pickResident(game, queue) {
        if (queue !== 'quick' || game !== 'e2e-quick') return null
        picks++
        const seat: ResidentSeat = {
          player_id: residentId,
          sink: { message: (frame) => { sinkGot.push(JSON.parse(frame) as Msg) } },
          socket: { send: () => {} },
          release: () => { released++ },
        }
        return seat
      },
    },
  })
  port = (await server.listen()).port
})

after(async () => {
  for (const ws of sockets) { try { ws.close() } catch { /* closing */ } }
  if (server) await server.close()
  server = null
})

function tick(ms: number): void {
  clock.t += ms
  server?.tick(clock.t)
}

interface Client {
  msgs: Msg[]
  send(m: Msg): void
  wait(pred: (m: Msg) => boolean, from?: number): Promise<Msg>
  close(): void
}

async function connect(onPort = port): Promise<Client> {
  const ws = new WsClient(`ws://127.0.0.1:${onPort}${RELAY_PATH}`)
  sockets.push(ws)
  const msgs: Msg[] = []
  const waiters: { pred(m: Msg): boolean; from: number; resolve(m: Msg): void }[] = []
  const pump = (): void => {
    for (const w of waiters.slice()) {
      const found = msgs.find((m, i) => i >= w.from && w.pred(m))
      if (found) { waiters.splice(waiters.indexOf(w), 1); w.resolve(found) }
    }
  }
  ws.on('message', (data: Buffer) => {
    msgs.push(JSON.parse(data.toString()) as Msg)
    pump()
  })
  ws.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    msgs,
    send(m) { ws.send(JSON.stringify(m)) },
    wait(pred, from = 0) {
      return new Promise((resolve, reject) => {
        const w = { pred, from, resolve: (m: Msg) => { clearTimeout(timer); resolve(m) } }
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error('timeout'))
        }, 1500)
        waiters.push(w)
        pump()
      })
    },
    close() { ws.close() },
  }
}

let tokenSeq = 0
async function guest(onPort = port, name?: string): Promise<[Client, Msg]> {
  const c = await connect(onPort)
  const token = `e2e-guest-token-${String(++tokenSeq).padStart(4, '0')}`
  c.send(name === undefined ? { t: 'auth', provider: 'guest', token } : { t: 'auth', provider: 'guest', token, name })
  const authed = await c.wait((m) => m.t === 'authed' || m.t === 'error')
  assert.equal(authed.t, 'authed')
  return [c, authed]
}

/** Round-trip probe: a repeated match_queue answers already_queued, in order. */
async function probe(c: Client, game: string, queue: string): Promise<void> {
  const from = c.msgs.length
  c.send({ t: 'match_queue', game, queue })
  const reply = await c.wait((m) => m.t === 'error', from)
  assert.equal(reply.reason, 'already_queued')
}

const hasMatch = (c: Client): boolean => c.msgs.some((m) => m.t === 'match')

test('auth: guest without a hook and a hook-verified wavedash player', { skip }, async () => {
  const bare = createHandshake({ config: { port: 0, host: '127.0.0.1', logLevel: 'error' } })
  const barePort = (await bare.listen()).port
  try {
    const [g1, a1] = await guest(barePort)
    assert.match(a1.display_name, /^Guest-[0-9A-F]{4}$/)
    assert.equal(a1.provider, 'guest')
    assert.equal(typeof a1.player_id, 'string')
    const [g2, a2] = await guest(barePort, '  Kevin  ')
    assert.equal(a2.display_name, 'Kevin')
    assert.equal(a2.provider, 'guest')
    const w = await connect(barePort)
    w.send({ t: 'auth', provider: 'wavedash', token: 'wd-good-token' })
    assert.equal((await w.wait((m) => m.t === 'error' || m.t === 'authed')).reason, 'auth_unavailable')
    for (const c of [g1, g2, w]) c.close()
  } finally {
    await bare.close()
  }

  const good = await connect()
  good.send({ t: 'auth', provider: 'wavedash', token: 'wd-good-token' })
  const ok = await good.wait((m) => m.t === 'authed' || m.t === 'error')
  assert.equal(ok.t, 'authed')
  assert.equal(ok.display_name, 'Wavey')
  assert.equal(ok.provider, 'wavedash')
  const bad = await connect()
  bad.send({ t: 'auth', provider: 'wavedash', token: 'wd-bad-token' })
  const err = await bad.wait((m) => m.t === 'error' || m.t === 'authed')
  assert.equal(err.t, 'error')
  assert.equal(err.reason, 'auth_failed')
})

test('quick: resident fallback after 8 s then relay pairing', { skip }, async () => {
  const [c] = await guest()
  c.send({ t: 'match_queue', game: 'e2e-quick', queue: 'quick' })
  const queued = await c.wait((m) => m.t === 'match_queued' || m.t === 'error')
  assert.equal(queued.t, 'match_queued')

  tick(7999)
  await probe(c, 'e2e-quick', 'quick')
  assert.equal(picks, 0)
  assert.equal(hasMatch(c), false)

  tick(1)
  const matched = await c.wait((m) => m.t === 'matched')
  const iMatch = c.msgs.findIndex((m) => m.t === 'match')
  assert.ok(iMatch >= 0 && iMatch < c.msgs.indexOf(matched), 'match comes before matched')
  const m = c.msgs[iMatch]
  assert.equal(m.queue, 'quick')
  assert.equal(m.game, 'e2e-quick')
  assert.equal(m.seat, 0)
  assert.equal(m.opponent.display_name, 'Resident')
  assert.equal(m.opponent.player_id, residentId)
  assert.equal(typeof matched.token, 'string')
  assert.ok(matched.token.length > 0)
  assert.equal(picks, 1)
  assert.equal(released, 0)
  const st = sinkGot.map((x) => x.t)
  assert.ok(st.includes('matched'), 'the resident sink received matched')
  assert.ok(st.indexOf('match') >= 0 && st.indexOf('match') < st.indexOf('matched'))
})

test('ranked: two players 250 apart pair only once the window reaches 300 (at 10 s)', { skip }, async () => {
  const game = 'e2e-ranked'
  const [x, ax] = await guest()
  const [y, ay] = await guest()
  let n = 0
  const dummy = async (): Promise<string> =>
    (await store.getOrCreateByIdentity({ provider: 'guest', external_id: `dummy-${++n}` })).player.player_id
  for (let i = 0; i < 2; i++) {
    await store.applyRankedResult({ match_id: `seed-x-${i}`, game, a: ax.player_id, b: await dummy(), score_a: 1 })
    await store.applyRankedResult({ match_id: `seed-y-${i}`, game, a: ay.player_id, b: await dummy(), score_a: 0 })
  }
  const rx = (await store.getRating(ax.player_id, game)).rating
  const ry = (await store.getRating(ay.player_id, game)).rating
  assert.ok(rx - ry > 200 && rx - ry <= 300, `gap ${rx - ry}`)

  const start = clock.t
  for (const c of [x, y]) {
    c.send({ t: 'match_queue', game, queue: 'ranked' })
    const q = await c.wait((m) => m.t === 'match_queued' || m.t === 'error')
    assert.equal(q.t, 'match_queued')
  }
  assert.equal(clock.t, start)

  for (const at of [5000, 9999]) {
    tick(start + at - clock.t)
    await probe(x, game, 'ranked')
    await probe(y, game, 'ranked')
    assert.equal(hasMatch(x) || hasMatch(y), false, `no match at ${at} ms`)
  }

  tick(start + 10000 - clock.t)
  for (const [c, seat, opp] of [[x, 0, ay], [y, 1, ax]] as const) {
    const matched = await c.wait((m) => m.t === 'matched')
    const m = c.msgs.find((v) => v.t === 'match')!
    assert.ok(c.msgs.indexOf(m) < c.msgs.indexOf(matched), 'match comes before matched')
    assert.equal(m.queue, 'ranked')
    assert.equal(m.seat, seat)
    assert.equal(m.opponent.player_id, opp.player_id)
  }
})

/** Pairs two fresh guests on a ranked queue of `game`; returns them with their match_id. */
async function rankedPair(game: string): Promise<[Client, Msg, Client, Msg, string]> {
  const [a, aa] = await guest()
  const [b, ab] = await guest()
  for (const c of [a, b]) {
    c.send({ t: 'match_queue', game, queue: 'ranked' })
    const q = await c.wait((m) => m.t === 'match_queued' || m.t === 'error')
    assert.equal(q.t, 'match_queued')
  }
  tick(1000)
  const ma = await a.wait((m) => m.t === 'match')
  const mb = await b.wait((m) => m.t === 'match')
  assert.equal(ma.match_id, mb.match_id)
  await a.wait((m) => m.t === 'matched')
  await b.wait((m) => m.t === 'matched')
  return [a, aa, b, ab, ma.match_id as string]
}

/** Round-trip probe for a matched socket: a result on an unknown match answers unknown_match, in order. */
async function probeResult(c: Client): Promise<void> {
  const from = c.msgs.length
  c.send({ t: 'result', match_id: 'no-such-match', outcome: 'win' })
  const reply = await c.wait((m) => m.t === 'error', from)
  assert.equal(reply.reason, 'unknown_match')
}

test('result: agreeing reports update the ratings to 2580/2420 and send match_end', { skip }, async () => {
  const game = 'e2e-result'
  const [a, aa, b, ab, matchId] = await rankedPair(game)

  a.send({ t: 'result', match_id: matchId, outcome: 'win' })
  assert.equal((await a.wait((m) => m.t === 'result_ack' || m.t === 'error')).match_id, matchId)
  b.send({ t: 'result', match_id: matchId, outcome: 'loss' })
  assert.equal((await b.wait((m) => m.t === 'result_ack' || m.t === 'error')).match_id, matchId)

  for (const [c, outcome, after] of [[a, 'win', 2580], [b, 'loss', 2420]] as const) {
    const end = await c.wait((m) => m.t === 'match_end')
    assert.equal(end.match_id, matchId)
    assert.equal(end.status, 'complete')
    assert.equal(end.outcome, outcome)
    assert.equal(end.rating.before, 2500)
    assert.equal(end.rating.after, after)
    assert.equal(end.rating.games, 1)
  }
  assert.equal((await store.getRating(aa.player_id, game)).rating, 2580)
  assert.equal((await store.getRating(ab.player_id, game)).rating, 2420)
  assert.equal((await store.getPlayer(aa.player_id))!.active_ranked_match, null)
  assert.equal((await store.getPlayer(ab.player_id))!.active_ranked_match, null)
})

test('forfeit: a socket closed for more than 90 s loses and the rating is applied', { skip }, async () => {
  const game = 'e2e-forfeit'
  const [a, aa, b, , matchId] = await rankedPair(game)

  a.close()
  await b.wait((m) => m.t === 'opp_dropped')

  tick(89999)
  await probeResult(b)
  assert.equal(b.msgs.some((m) => m.t === 'match_end'), false, 'no match_end at 89999 ms')

  tick(2)
  const end = await b.wait((m) => m.t === 'match_end')
  assert.equal(end.match_id, matchId)
  assert.equal(end.status, 'forfeit')
  assert.equal(end.outcome, 'win')
  assert.equal(end.rating.after, 2580)
  assert.equal((await store.getRating(aa.player_id, game)).rating, 2420)
})
