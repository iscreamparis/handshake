// Scenario tests for the GameNet relay (RelayHub) over real sockets against
// createHandshake, on RELAY_PATH. Ported from reference/pwaphaser-relay/relay.test.mjs
// (the scenario list is docs/RELAY.md section 12); names are kept EXACTLY as the
// reference. Covers all 51 scenarios, including reconnection, replay and timers.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHandshake } from '../src/handshake.ts'
import type { Handshake } from '../src/handshake.ts'
import { RELAY_PATH } from '../src/relay/protocol.ts'

type Msg = Record<string, any>

let WsClient: any = null
try {
  WsClient = (await import('ws')).WebSocket
} catch {
  WsClient = null
}
const skip = WsClient === null ? 'ws not installed' : false

const clock = { t: 1_000_000 }
let server: Handshake | null = null
let port = 0
const clients: Client[] = []

before(async () => {
  if (skip) return
  server = createHandshake({
    config: { port: 0, host: '127.0.0.1', logLevel: 'error' },
    deps: { now: () => clock.t },
    autoTick: false,
  })
  const listening = await server.listen()
  port = listening.port
})

after(async () => {
  for (const c of clients) { try { c.ws.close() } catch { /* closing */ } }
  if (server) await server.close()
  server = null
})

// Protocol deadlines advance only through this clock and handshake.tick.
function tick(ms: number): void {
  clock.t += ms
  server?.tick(clock.t)
}

interface Client {
  ws: any
  msgs: Msg[]
  closed: Promise<{ code: number; reason: string }>
  mark(): number
  send(m: Msg): void
  sendRaw(s: string): void
  wait(pred: (m: Msg) => boolean, ms?: number, from?: number): Promise<Msg>
  next(type: string): Promise<Msg>
  expectNone(pred: (m: Msg) => boolean, ms?: number, from?: number): Promise<boolean>
  waitClose(ms?: number): Promise<void>
}

async function connect(): Promise<Client> {
  const ws = new WsClient(`ws://127.0.0.1:${port}${RELAY_PATH}`)
  const msgs: Msg[] = []
  const taken: Record<string, number> = {}
  let isClosed = false
  const waiters: { kind: string; pred?(m: Msg): boolean; from?: number; resolve(m?: Msg): void; reject(e: Error): void; timer?: ReturnType<typeof setTimeout> }[] = []
  const remove = (w: (typeof waiters)[number]): void => {
    const i = waiters.indexOf(w)
    if (i >= 0) waiters.splice(i, 1)
    if (w.timer) clearTimeout(w.timer)
  }
  const pump = (): void => {
    for (const w of waiters.slice()) {
      if (w.kind === 'close') {
        if (isClosed) { remove(w); w.resolve() }
        continue
      }
      const from = w.from ?? 0
      const idx = msgs.findIndex((m, i) => i >= from && (w.pred as (m: Msg) => boolean)(m))
      if (idx >= 0) { remove(w); w.resolve(msgs[idx]) }
    }
  }
  ws.on('message', (data: Buffer) => {
    let m: Msg
    const text = data.toString()
    try { m = JSON.parse(text) as Msg } catch { m = { _raw: text } }
    msgs.push(m)
    pump()
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code: number, reason: Buffer) => {
      isClosed = true
      resolve({ code, reason: reason.toString() })
      pump()
    })
  })
  ws.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  function wait(pred: (m: Msg) => boolean, ms = 1500, from = 0): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const w = { kind: 'msg', pred, from, resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined }
      w.timer = setTimeout(() => { remove(w); reject(new Error('timeout')) }, ms)
      waiters.push(w)
      pump()
    })
  }

  async function next(type: string): Promise<Msg> {
    for (;;) {
      const k = taken[type] ?? 0
      let seen = -1
      for (const m of msgs) {
        if (m.t === type && ++seen === k) { taken[type] = k + 1; return m }
      }
      await wait(() => true, 1500, msgs.length)
    }
  }

  const client: Client = {
    ws,
    msgs,
    closed,
    mark: () => msgs.length,
    send(m: Msg) { try { ws.send(JSON.stringify(m)) } catch { /* closed socket */ } },
    sendRaw(s: string) { try { ws.send(s) } catch { /* closed socket */ } },
    wait,
    next,
    async expectNone(pred, ms = 400, from = 0) {
      try { await wait(pred, ms, from); return false } catch { return true }
    },
    waitClose(ms = 1500) {
      return new Promise<void>((resolve, reject) => {
        const w = { kind: 'close', resolve: () => { clearTimeout(w.timer); resolve() }, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined }
        w.timer = setTimeout(() => { remove(w); reject(new Error('timeout')) }, ms)
        waiters.push(w)
        pump()
      })
    },
  }
  clients.push(client)
  return client
}

async function pair(nameA = 'yang', nameB = 'yin'): Promise<[Client, Client, Msg, Msg]> {
  const a = await connect()
  const b = await connect()
  a.send({ t: 'queue', payload: { name: nameA } })
  await a.next('queued')
  b.send({ t: 'queue', payload: { name: nameB } })
  const [ma, mb] = await Promise.all([a.next('matched'), b.next('matched')])
  return [a, b, ma, mb]
}

async function pair3(): Promise<{ p: Client[]; m: Msg[] }> {
  const p = [await connect(), await connect(), await connect()]
  p[0].send({ t: 'queue', players: 3, payload: { name: 'a' } })
  await p[0].next('queued')
  p[1].send({ t: 'queue', players: 3, payload: { name: 'b' } })
  await p[1].next('queued')
  p[2].send({ t: 'queue', players: 3, payload: { name: 'c' } })
  const m = await Promise.all(p.map((c) => c.next('matched')))
  return { p, m }
}

test('appariement : les deux pairs reçoivent la même seed', { skip }, async () => {
  const [, , m1, m2] = await pair()
  assert.equal(m1.youAre, 0)
  assert.equal(m2.youAre, 1)
  assert.equal(m1.seed, m2.seed)
})

test('la charge utile de mise en file est transmise telle quelle au pair', { skip }, async () => {
  const [, , m1, m2] = await pair()
  assert.equal(m1.opp.name, 'yin')
  assert.equal(m2.opp.name, 'yang')
})

test('action relayée hôte -> invité', { skip }, async () => {
  const [a, b] = await pair()
  const mk = b.mark()
  a.send({ t: 'act', a: { k: 'move', x: 3, y: 7 } })
  const got = await b.wait((m) => m.t === 'act', 1500, mk)
  assert.equal(got.a.k, 'move')
})

test('action relayée invité -> hôte', { skip }, async () => {
  const [a, b] = await pair()
  const mk = a.mark()
  b.send({ t: 'act', a: { k: 'fire', target: 2 } })
  const got = await a.wait((m) => m.t === 'act', 1500, mk)
  assert.equal(got.a.k, 'fire')
})

test('act non-objet non relayé (pair silencieux)', { skip }, async () => {
  const [a, b] = await pair()
  const mk = b.mark()
  a.send({ t: 'act', a: 'pas un objet' })
  assert.equal(await b.expectNone((m) => m.t === 'act', 400, mk), true)
  assert.equal(a.ws.readyState, 1)
})

test('act trop profond non relayé', { skip }, async () => {
  const [a, b] = await pair()
  let deep: Record<string, unknown> = { k: 'deep' }
  for (let i = 0; i < 12; i++) deep = { nested: deep }
  const mk = b.mark()
  a.send({ t: 'act', a: deep })
  assert.equal(await b.expectNone((m) => m.t === 'act', 400, mk), true)
})

test('message géant (>4 Ko) ignoré', { skip }, async () => {
  const [a, b] = await pair()
  const mk = b.mark()
  a.sendRaw(JSON.stringify({ t: 'act', a: { k: 'end' }, pad: 'x'.repeat(5000) }))
  assert.equal(await b.expectNone((m) => m.t === 'act', 400, mk), true)
  assert.equal(a.ws.readyState, 1)
})

test('liste de 30 entiers relayée (deck)', { skip }, async () => {
  const [a, b] = await pair()
  const mk = b.mark()
  a.send({ t: 'act', a: { k: 'deck', ids: Array.from({ length: 30 }, (_, i) => i) } })
  const deck = await b.wait((m) => m.t === 'act' && m.a.k === 'deck', 1500, mk)
  assert.equal(deck.a.ids.length, 30)
})

test('tableau de 900 éléments refusé', { skip }, async () => {
  const [a, b] = await pair()
  const mk = b.mark()
  a.send({ t: 'act', a: { k: 'flood', ids: Array.from({ length: 900 }, (_, i) => i) } })
  assert.equal(await b.expectNone((m) => m.t === 'act' && m.a.k === 'flood', 400, mk), true)
})

test('action acceptée -> ack avec son n°', { skip }, async () => {
  const [a] = await pair()
  a.send({ t: 'act', a: { k: 'end' }, n: 3 })
  const ack = await a.wait((m) => m.t === 'ack', 1500)
  assert.equal(ack.n, 3)
})

test('doublon -> ré-acquitté (l\'outbox du client se vide quand même)', { skip }, async () => {
  const [a] = await pair()
  a.send({ t: 'act', a: { k: 'end' }, n: 3 })
  await a.wait((m) => m.t === 'ack', 1500)
  const mk = a.mark()
  a.send({ t: 'act', a: { k: 'end' }, n: 3 })
  const ackDup = await a.wait((m) => m.t === 'ack', 1500, mk)
  assert.equal(ackDup.n, 3)
})

test('ping -> pong', { skip }, async () => {
  const c = await connect()
  c.send({ t: 'ping' })
  const pong = await c.next('pong')
  assert.equal(pong.t, 'pong')
})

test('bye -> opp_left immédiat (pas de sursis)', { skip }, async () => {
  const [a, b] = await pair()
  const mk = b.mark()
  a.send({ t: 'bye' })
  const left = await b.wait((m) => m.t === 'opp_left', 1500, mk)
  assert.equal(left.t, 'opp_left')
})

test('10 acts malformés -> socket fermée', { skip }, async () => {
  const c = await connect()
  for (let i = 0; i < 10; i++) c.send({ t: 'act', a: 'malforme-' + i })
  await c.waitClose(1500)
})

test('flood > 20 msg/s -> erreur « rate limited »', { skip }, async () => {
  const c = await connect()
  for (let i = 0; i < 30; i++) c.send({ t: 'unqueue' })
  const err = await c.next('error')
  assert.equal(err.reason, 'rate limited')
})

test('flood > 20 msg/s -> socket fermée', { skip }, async () => {
  const c = await connect()
  for (let i = 0; i < 30; i++) c.send({ t: 'unqueue' })
  await c.waitClose(2000)
})

test('unqueue -> unqueued', { skip }, async () => {
  const c = await connect()
  c.send({ t: 'queue', payload: { name: 'yang' } })
  await c.next('queued')
  c.send({ t: 'unqueue' })
  const uq = await c.next('unqueued')
  assert.equal(uq.t, 'unqueued')
})

test('file à 3 : deux joueurs ne suffisent pas à démarrer', { skip }, async () => {
  const p = [await connect(), await connect(), await connect()]
  p[0].send({ t: 'queue', players: 3, payload: { name: 'a' } })
  await p[0].next('queued')
  p[1].send({ t: 'queue', players: 3, payload: { name: 'b' } })
  await p[1].next('queued')
  assert.equal(await p[0].expectNone((m) => m.t === 'matched', 300), true)
  p[2].send({ t: 'queue', players: 3, payload: { name: 'c' } })
  await Promise.all(p.map((c) => c.next('matched')))
})

test('appariement à 3 : sièges 0/1/2 distincts', { skip }, async () => {
  const { m } = await pair3()
  assert.deepEqual(m.map((x) => x.youAre), [0, 1, 2])
})

test('appariement à 3 : une seule et même seed', { skip }, async () => {
  const { m } = await pair3()
  assert.equal(m[0].seed, m[1].seed)
  assert.equal(m[1].seed, m[2].seed)
})

test('appariement à 3 : `players` annoncé', { skip }, async () => {
  const { m } = await pair3()
  assert.equal(m.every((x) => x.players === 3), true)
})

test('appariement à 3 : `opps` porte la charge des trois sièges', { skip }, async () => {
  const { m } = await pair3()
  assert.equal(Array.isArray(m[0].opps), true)
  assert.equal(m[0].opps.length, 3)
  assert.equal(m[0].opps[0].name, 'a')
  assert.equal(m[0].opps[1].name, 'b')
  assert.equal(m[0].opps[2].name, 'c')
})

test('appariement à 3 : jetons de reprise tous différents', { skip }, async () => {
  const { m } = await pair3()
  assert.equal(new Set(m.map((x) => x.token)).size, 3)
})

test('les files sont séparées par format (1v1 pas aspiré par une file à 4)', { skip }, async () => {
  const solo = await connect()
  solo.send({ t: 'queue', payload: { name: 'duo' } })
  await solo.next('queued')
  const q4 = [await connect(), await connect()]
  for (const c of q4) c.send({ t: 'queue', players: 4, payload: null })
  assert.equal(await solo.expectNone((m) => m.t === 'matched', 500), true)
  solo.send({ t: 'unqueue' })
  await solo.next('unqueued')
})

test('action diffusée aux DEUX autres sièges', { skip }, async () => {
  const { p } = await pair3()
  const mk1 = p[1].mark()
  const mk2 = p[2].mark()
  p[0].send({ t: 'act', a: { k: 'move', x: 1 }, n: 1 })
  const r1 = await p[1].wait((m) => m.t === 'act', 1500, mk1)
  const r2 = await p[2].wait((m) => m.t === 'act', 1500, mk2)
  assert.equal(!!r1 && !!r2, true)
})

test('action estampillée du siège émetteur (`from`)', { skip }, async () => {
  const { p } = await pair3()
  const mk1 = p[1].mark()
  const mk2 = p[2].mark()
  p[0].send({ t: 'act', a: { k: 'move', x: 1 }, n: 1 })
  const r1 = await p[1].wait((m) => m.t === 'act', 1500, mk1)
  const r2 = await p[2].wait((m) => m.t === 'act', 1500, mk2)
  assert.equal(r1.from, 0)
  assert.equal(r2.from, 0)
})

test('n° de séquence indépendants par siège (n=1 des sièges 1 ET 2 passent)', { skip }, async () => {
  const { p } = await pair3()
  const mk = p[0].mark()
  p[1].send({ t: 'act', a: { k: 'seat1' }, n: 1 })
  p[2].send({ t: 'act', a: { k: 'seat2' }, n: 1 })
  const got1 = await p[0].wait((m) => m.t === 'act' && m.a.k === 'seat1', 1500, mk)
  const got2 = await p[0].wait((m) => m.t === 'act' && m.a.k === 'seat2', 1500, mk)
  assert.equal(got1.from, 1)
  assert.equal(got2.from, 2)
})

test('départ d\'un joueur sur 3 -> `player_left` avec son siège', { skip }, async () => {
  const { p } = await pair3()
  const mk = p[2].mark()
  p[1].send({ t: 'bye' })
  const pl = await p[2].wait((m) => m.t === 'player_left', 1500, mk)
  assert.equal(pl.seat, 1)
})

test('départ d\'un joueur sur 3 -> la partie N\'EST PAS finie', { skip }, async () => {
  const { p } = await pair3()
  p[1].send({ t: 'bye' })
  await p[2].next('player_left')
  assert.equal(await p[2].expectNone((m) => m.t === 'opp_left', 400), true)
})

test('la partie continue entre les survivants', { skip }, async () => {
  const { p } = await pair3()
  p[1].send({ t: 'bye' })
  await p[2].next('player_left')
  const mk = p[2].mark()
  p[0].send({ t: 'act', a: { k: 'encore' }, n: 2 })
  const alive = await p[2].wait((m) => m.t === 'act' && m.a.k === 'encore', 1500, mk)
  assert.equal(alive.from, 0)
})

test('dernier joueur debout -> `opp_left` (fin de partie)', { skip }, async () => {
  const { p } = await pair3()
  p[1].send({ t: 'bye' })
  await p[2].next('player_left')
  const mk = p[2].mark()
  p[0].send({ t: 'bye' })
  const end = await p[2].wait((m) => m.t === 'opp_left', 1500, mk)
  assert.equal(end.t, 'opp_left')
})

test('salle cadencée : 45 actions d\'affilée passent sans coupure', { skip }, async () => {
  const k1 = await connect()
  const k2 = await connect()
  k1.send({ t: 'queue', cadence: true, payload: null })
  await k1.next('queued')
  k2.send({ t: 'queue', cadence: true, payload: null })
  await Promise.all([k1.next('matched'), k2.next('matched')])
  const mk = k2.mark()
  for (let i = 1; i <= 45; i++) k1.send({ t: 'act', a: { k: 'i', v: i }, n: i })
  const last = await k2.wait((m) => m.t === 'act' && m.a.v === 45, 2000, mk)
  assert.equal(last.a.v, 45)
  assert.equal(k1.ws.readyState, 1)
})

test('salle cadencée : le plafond existe toujours (200 msg d\'un coup -> coupé)', { skip }, async () => {
  const k1 = await connect()
  const k2 = await connect()
  k1.send({ t: 'queue', cadence: true, payload: null })
  await k1.next('queued')
  k2.send({ t: 'queue', cadence: true, payload: null })
  await Promise.all([k1.next('matched'), k2.next('matched')])
  for (let i = 1; i <= 200; i++) k1.send({ t: 'act', a: { k: 'i', v: i }, n: i })
  const err = await k1.next('error')
  assert.equal(err.reason, 'rate limited')
})

// Reproduce the reference duel's recv=[1,1], then miss seat 1's second action.
// The socket exchange is awaited before ticking so the disconnect has armed
// its deadline and the action has entered the replay log.
async function resumeDuel() {
  const [a, b, ma] = await pair()
  a.send({ t: 'act', a: { k: 'move', x: 3, y: 7 }, n: 1 })
  await b.next('act')
  b.send({ t: 'act', a: { k: 'fire', target: 2 }, n: 1 })
  await a.next('act')
  a.ws.close()
  const dropped = await b.next('opp_dropped')
  await a.closed
  tick(dropped.graceMs - 1)
  b.send({ t: 'act', a: { k: 'end' }, n: 2 })
  await b.wait((m) => m.t === 'ack' && m.n === 2)
  const returning = await connect()
  returning.send({ t: 'resume', token: ma.token, have: 1 })
  const resumed = await returning.next('resumed')
  const back = await b.next('opp_back')
  return { a, b, returning, resumed, back }
}

test('jeton de reprise fourni à l\'appariement', { skip }, async () => {
  const [, , ma, mb] = await pair()
  assert.equal(typeof ma.token, 'string')
  assert.equal(typeof mb.token, 'string')
  assert.notEqual(ma.token, mb.token)
})

test('coupure brutale -> opp_dropped (partie en sursis)', { skip }, async () => {
  const [a, b] = await pair()
  a.ws.close()
  const dropped = await b.next('opp_dropped')
  assert.equal(dropped.t, 'opp_dropped')
  assert.equal(dropped.graceMs, 60_000)
})

test('coupure brutale -> PAS de opp_left immédiat', { skip }, async () => {
  const [a, b] = await pair()
  a.ws.close()
  const dropped = await b.next('opp_dropped')
  tick(dropped.graceMs - 1)
  assert.equal(await b.expectNone((m) => m.t === 'opp_left', 400), true)
})

test('reprise acceptée (resumed + ack de mes actions reçues)', { skip }, async () => {
  const { resumed } = await resumeDuel()
  assert.deepEqual(resumed, { t: 'resumed', ack: 1 })
})

test('actions manquées rejouées au revenant', { skip }, async () => {
  const { returning } = await resumeDuel()
  const replay = await returning.next('act')
  assert.deepEqual(replay, { t: 'act', a: { k: 'end' }, n: 2, from: 1 })
  // Pong follows all replay frames: inspect the complete replay without a delay.
  returning.send({ t: 'ping' })
  await returning.next('pong')
  assert.deepEqual(returning.msgs.filter((m) => m.t === 'act'), [replay])
  assert.equal(returning.msgs[0].t, 'resumed')
})

test('le pair est prévenu du retour (opp_back)', { skip }, async () => {
  const { back } = await resumeDuel()
  assert.deepEqual(back, { t: 'opp_back' })
})

test('action renvoyée après reprise -> dédoublonnée', { skip }, async () => {
  const { b, returning } = await resumeDuel()
  const mk = b.mark()
  returning.send({ t: 'act', a: { k: 'move', x: 3, y: 7 }, n: 1 })
  assert.equal((await returning.next('ack')).n, 1)
  assert.equal(await b.expectNone((m) => m.t === 'act', 400, mk), true)
})

test('duel relayé normalement après reprise', { skip }, async () => {
  const { b, returning } = await resumeDuel()
  // Cross the original disconnect deadline after resuming: it must be canceled.
  tick(1)
  const mk = b.mark()
  returning.send({ t: 'act', a: { k: 'end' }, n: 2 })
  const act = await b.wait((m) => m.t === 'act', 1500, mk)
  assert.deepEqual(act, { t: 'act', a: { k: 'end' }, n: 2, from: 0 })
  assert.equal(b.msgs.some((m) => m.t === 'opp_left'), false)
})

// Resume while the old connection is still open, as in the half-open case.
async function resumeLiveDuel() {
  const [a, b, ma] = await pair()
  a.send({ t: 'act', a: { k: 'end' }, n: 1 })
  await b.next('act')
  const returning = await connect()
  returning.send({ t: 'resume', token: ma.token, have: 0 })
  await returning.next('resumed')
  return { a, b, returning }
}

test('reprise -> l\'ancienne socket est TUÉE (plus de zombie)', { skip }, async () => {
  const { a } = await resumeLiveDuel()
  await a.waitClose(2000)
  await a.closed
  assert.equal(a.ws.readyState, 3)
})

test('action venue d\'une socket zombie -> jamais relayée', { skip }, async () => {
  const { a, b } = await resumeLiveDuel()
  await a.waitClose(2000)
  const mk = b.mark()
  a.send({ t: 'act', a: { k: 'end' }, n: 2 })
  assert.equal(await b.expectNone((m) => m.t === 'act', 500, mk), true)
})

test('le duel continue après la reprise', { skip }, async () => {
  const { a, b, returning } = await resumeLiveDuel()
  await a.waitClose(2000)
  const mk = returning.mark()
  b.send({ t: 'act', a: { k: 'end' }, n: 1 })
  const act = await returning.wait((m) => m.t === 'act', 1500, mk)
  assert.deepEqual(act, { t: 'act', a: { k: 'end' }, n: 1, from: 1 })
})

test('jeton inconnu -> « resume expired »', { skip }, async () => {
  const c = await connect()
  c.send({ t: 'resume', token: 'a'.repeat(36), have: 0 })
  assert.deepEqual(await c.next('error'), { t: 'error', reason: 'resume expired' })
})

test('fenêtre de reprise expirée -> opp_left', { skip }, async () => {
  const [a, b, ma] = await pair()
  a.ws.close()
  const dropped = await b.next('opp_dropped')
  await a.closed
  tick(dropped.graceMs - 1)
  b.send({ t: 'ping' })
  await b.next('pong')
  assert.equal(b.msgs.some((m) => m.t === 'opp_left'), false)
  tick(1)
  assert.deepEqual(await b.next('opp_left'), { t: 'opp_left' })
  const returning = await connect()
  returning.send({ t: 'resume', token: ma.token, have: 0 })
  assert.deepEqual(await returning.next('error'), { t: 'error', reason: 'resume expired' })
})

async function resumeTrio() {
  const { p, m } = await pair3()
  p[0].send({ t: 'act', a: { k: 'move', x: 1 }, n: 1 })
  await Promise.all([p[1].next('act'), p[2].next('act')])
  p[1].send({ t: 'act', a: { k: 'seat1' }, n: 1 })
  await p[0].wait((msg) => msg.t === 'act' && msg.from === 1)
  p[2].send({ t: 'act', a: { k: 'seat2' }, n: 1 })
  await p[0].wait((msg) => msg.t === 'act' && msg.from === 2)
  p[0].ws.close()
  const dropped = await Promise.all([p[1].next('player_dropped'), p[2].next('player_dropped')])
  await p[0].closed
  tick(dropped[0].graceMs - 1)
  const returning = await connect()
  returning.send({ t: 'resume', token: m[0].token, have: [0, 1, 0] })
  const resumed = await returning.next('resumed')
  const back = await Promise.all([p[1].next('player_back'), p[2].next('player_back')])
  return { p, returning, resumed, back }
}

test('coupure à 3 -> `player_dropped` avec le siège concerné', { skip }, async () => {
  const { p } = await pair3()
  p[0].ws.close()
  const dropped = await Promise.all([p[1].next('player_dropped'), p[2].next('player_dropped')])
  for (const msg of dropped) {
    assert.deepEqual(msg, { t: 'player_dropped', seat: 0, graceMs: 60_000 })
  }
})

test('reprise à 3 acceptée', { skip }, async () => {
  const { resumed } = await resumeTrio()
  assert.deepEqual(resumed, { t: 'resumed', ack: 1 })
})

test('rejeu sélectif : seule l\'action du siège NON couvert par `have` revient', { skip }, async () => {
  const { returning } = await resumeTrio()
  const replay = await returning.next('act')
  assert.deepEqual(replay, { t: 'act', a: { k: 'seat2' }, n: 1, from: 2 })
  returning.send({ t: 'ping' })
  await returning.next('pong')
  assert.deepEqual(returning.msgs.filter((msg) => msg.t === 'act'), [replay])
  assert.equal(returning.msgs[0].t, 'resumed')
})

test('rejeu sélectif : l\'action déjà couverte n\'est PAS rejouée', { skip }, async () => {
  const { returning } = await resumeTrio()
  assert.equal(await returning.expectNone((msg) => msg.t === 'act' && msg.a.k === 'seat1', 400), true)
})

test('reprise à 3 : les autres sont prévenus (`player_back`)', { skip }, async () => {
  const { p, returning, back } = await resumeTrio()
  for (const msg of back) assert.deepEqual(msg, { t: 'player_back', seat: 0 })
  tick(1)
  returning.send({ t: 'act', a: { k: 'encore' }, n: 2 })
  const acts = await Promise.all(p.slice(1).map((c) => c.wait((msg) => msg.t === 'act' && msg.n === 2)))
  for (const msg of acts) assert.equal(msg.from, 0)
  for (const c of p.slice(1)) assert.equal(c.msgs.some((msg) => msg.t === 'player_left'), false)
})
