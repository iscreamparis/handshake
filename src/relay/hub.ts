// Transport-agnostic GameNet relay with tick-driven reconnection deadlines.
import type { ClientConn } from '../hub.ts'
import type { RelayClientMessage, RelayMessage, RelayMatched } from './protocol.ts'
import {
  CADENCE_RATE_PER_MIN, CADENCE_RATE_PER_SEC, MAX_INVALID, MAX_LOG_ACTS,
  MAX_LOG_ACTS_CADENCE, MAX_ROOMS, MAX_SOCKETS, RATE_MINUTE_WINDOW_MS,
  RATE_PER_MIN, RATE_PER_SEC, RATE_SECOND_WINDOW_MS, RESUME_GRACE_MS,
  encodeRelay, parseRelayMessage,
} from './protocol.ts'

export interface RelayDeps { now(): number; random(): number; log(level: string, msg: string): void }
export interface RelaySeatRef { session: string; seat: number; conn: string }
export interface RelayExtension {
  message(conn: string, msg: Record<string, unknown>): boolean
  connClosed(conn: string, seat: RelaySeatRef | null): void
  seatResumed(seat: RelaySeatRef): void
  sessionEnded(session: string): void
  tick(nowMs: number): void
}

interface Client {
  id: string
  conn: ClientConn
  roomCode: string | null
  cadence: boolean
  invalidCount: number
  msgTimes: number[]
}

interface Session {
  players: number
  cadence: boolean
  opts: { private?: boolean; quick?: boolean }
  seats: (string | null)[]
  // The reference forwards payloads verbatim, including primitive values.
  payloads: unknown[]
  tokens: string[] | null
  recv: number[]
  down: (number | null)[]
  gone: boolean[]
  log: { side: number; n: number; a: Record<string, unknown> | unknown[] }[]
  holdMs: number
}

interface Waiter { conn: string; payload: unknown; since: number }

export class RelayHub {
  private deps: RelayDeps
  private ext?: RelayExtension
  private clients = new Map<string, Client>()
  private sessions = new Map<string, Session>()
  private resumeIndex = new Map<string, { code: string; side: number }>()
  private waitLists = new Map<string, Waiter[]>()
  private recentWaitsMs: number[] = []
  private quickSeq = 0
  private counter = 0

  constructor(deps: RelayDeps, ext?: RelayExtension) {
    this.deps = deps
    this.ext = ext
  }

  connect(conn: ClientConn, _url: string): string {
    if (this.clients.size >= MAX_SOCKETS) {
      conn.send(encodeRelay({ t: 'error', reason: 'server full' }))
      // ClientConn requires arguments, but the relay closes without a status.
      ;(conn.close as () => void)()
      return ''
    }
    const hex = Math.floor(this.deps.random() * 0x100000000).toString(16).padStart(8, '0')
    const id = `c${++this.counter}-${hex}`
    this.clients.set(id, { id, conn, roomCode: null, cadence: false, invalidCount: 0, msgTimes: [] })
    return id
  }

  message(conn: string, raw: string): void {
    const c = this.clients.get(conn)
    if (!c) return
    try {
      const now = this.deps.now()
      if (this.rateLimited(c, now)) {
        this.sendError(conn, 'rate limited', 'rate limited')
        this.closeClient(c)
        return
      }
      const parsed = parseRelayMessage(raw)
      if ('error' in parsed) {
        // Queue payload validation in the reference emits an error rather
        // than counting an invalid frame. Validate the remaining fields with
        // the protocol parser before reproducing that response.
        if (parsed.message === 'invalid message') {
          const frame = JSON.parse(raw) as Record<string, unknown> | null
          // The reference coerces join codes in the handler rather than
          // requiring a string during validation.
          if (frame && frame.t === 'join') {
            this.dispatch(c, { t: 'join', code: String(frame.code || ''), payload: frame.payload } as RelayClientMessage, now)
            return
          }
          if (frame && frame.t === 'queue') {
            const withoutPayload = parseRelayMessage(JSON.stringify({ ...frame, payload: null }))
            if (!('error' in withoutPayload)) {
              this.sendError(conn, 'bad queue payload', 'bad queue payload')
              return
            }
          }
        }
        this.dropInvalid(c)
        return
      }
      if ('ext' in parsed) {
        if (!this.ext?.message(conn, parsed.ext)) this.dropInvalid(c)
        return
      }
      this.dispatch(c, parsed as RelayClientMessage, now)
    } catch {
      // Extension failures can contain secrets; do not include their text.
      this.deps.log('error', `[relay] message from ${conn} failed`)
      this.sendError(conn, 'internal', 'internal server error')
    }
  }

  disconnect(conn: string): void {
    const c = this.clients.get(conn)
    if (!c) return
    const seat = this.seatOf(conn)
    this.clients.delete(conn)
    this.cleanup(c)
    this.ext?.connClosed(conn, seat)
  }

  tick(nowMs: number): void {
    for (const [code, room] of [...this.sessions]) {
      for (let side = 0; side < room.players; side++) {
        const deadline = room.down[side]
        if (deadline !== null && nowMs >= deadline) this.endSeat(code, room, side)
        if (!this.sessions.has(code)) break
      }
    }
    this.ext?.tick(nowMs)
  }

  stats(): { sessions: number; clients: number } {
    return { sessions: this.sessions.size, clients: this.clients.size }
  }

  send(conn: string, msg: Record<string, unknown>): void {
    const c = this.clients.get(conn)
    if (!c) return
    try { c.conn.send(encodeRelay(msg as RelayMessage)) } catch {
      this.deps.log('error', `[relay] send to ${conn} failed`)
    }
  }

  sendError(conn: string, code: string, _message: string): void {
    this.send(conn, { t: 'error', reason: code })
  }

  pairInto(a: string, b: string, opts: { holdMs: number }): [RelaySeatRef, RelaySeatRef] {
    if (a === b || !this.clients.has(a) || !this.clients.has(b)) throw new Error('invalid relay pair')
    if (this.seatOf(a) || this.seatOf(b)) throw new Error('relay client already seated')
    if (!Number.isFinite(opts.holdMs) || opts.holdMs < 0) throw new Error('invalid relay hold')
    if (this.sessions.size >= MAX_ROOMS) throw new Error('server full')
    this.dropFromWaitLists(a)
    this.dropFromWaitLists(b)
    const code = this.pairQuick([
      { conn: a, payload: null, since: this.deps.now() },
      { conn: b, payload: null, since: this.deps.now() },
    ], false, opts.holdMs)
    return [{ session: code, seat: 0, conn: a }, { session: code, seat: 1, conn: b }]
  }

  endSession(session: string, _reason: string): void {
    const room = this.sessions.get(session)
    if (!room) return
    this.broadcast(room, { t: 'opp_left' }, -1)
    this.destroyRoom(session, room)
  }

  seatOf(conn: string): RelaySeatRef | null {
    const code = this.clients.get(conn)?.roomCode
    const room = code ? this.sessions.get(code) : undefined
    const seat = room?.seats.indexOf(conn) ?? -1
    return code && seat >= 0 ? { session: code, seat, conn } : null
  }

  private dispatch(c: Client, msg: RelayClientMessage, now: number): void {
    switch (msg.t) {
      case 'create': {
        if (this.sessions.size >= MAX_ROOMS) return this.sendError(c.id, 'server full', 'server full')
        const code = this.newCode()
        if (!code) return this.sendError(c.id, 'server full', 'server full')
        const room = this.makeSession(msg.players ?? 2, !!msg.cadence, { private: true })
        room.seats[0] = c.id
        room.payloads[0] = msg.payload ?? null
        this.sessions.set(code, room)
        c.roomCode = code
        this.send(c.id, { t: 'room', code })
        return
      }
      case 'join': {
        const code = String(msg.code || '')
        const room = this.sessions.get(code)
        if (!room) return this.sendError(c.id, 'room not found', 'room not found')
        const free = room.seats.indexOf(null)
        if (free < 0 || room.tokens) return this.sendError(c.id, 'room full', 'room full')
        room.seats[free] = c.id
        room.payloads[free] = msg.payload ?? null
        c.roomCode = code
        if (room.seats.includes(null)) {
          this.send(c.id, { t: 'waiting', seat: free, players: room.players })
        } else this.startRoom(code, room)
        return
      }
      case 'queue': return this.queue(c, msg, now)
      case 'unqueue':
        this.dropFromWaitLists(c.id)
        return this.send(c.id, { t: 'unqueued' })
      case 'act': {
        const room = this.sessions.get(c.roomCode ?? '')
        if (!room) return
        const side = room.seats.indexOf(c.id)
        if (side < 0) return
        const n = msg.n ?? room.recv[side] + 1
        if (n <= room.recv[side]) return this.send(c.id, { t: 'ack', n })
        room.recv[side] = n
        room.log.push({ side, n, a: msg.a })
        if (room.log.length > (room.cadence ? MAX_LOG_ACTS_CADENCE : MAX_LOG_ACTS)) room.log.shift()
        this.send(c.id, { t: 'ack', n })
        this.broadcast(room, { t: 'act', a: msg.a, n, from: side }, side)
        return
      }
      case 'ping': return this.send(c.id, { t: 'pong' })
      case 'resume': return this.resume(c, msg, now)
      case 'bye': return this.cleanup(c, true)
    }
  }

  private queue(c: Client, msg: Extract<RelayClientMessage, { t: 'queue' }>, now: number): void {
    for (const list of this.waitLists.values()) if (list.some((e) => e.conn === c.id)) return
    const players = msg.players ?? 2
    const cadence = !!msg.cadence
    const key = `${players}|${cadence ? 1 : 0}`
    const list = this.waitLists.get(key) ?? []
    this.waitLists.set(key, list)
    for (let i = list.length - 1; i >= 0; i--) {
      if (!this.clients.has(list[i].conn)) list.splice(i, 1)
    }
    list.push({ conn: c.id, payload: msg.payload ?? null, since: now })
    if (list.length < players) {
      const last = this.recentWaitsMs.slice(-10)
      const estimateMs = last.length ? Math.round(last.reduce((sum, n) => sum + n, 0) / last.length) : null
      return this.send(c.id, { t: 'queued', estimateMs })
    }
    if (this.sessions.size >= MAX_ROOMS) {
      list.pop()
      return this.sendError(c.id, 'server full', 'server full')
    }
    const seated = list.splice(0, players)
    if (!list.length) this.waitLists.delete(key)
    for (const e of seated) {
      this.recentWaitsMs.push(now - e.since)
      if (this.recentWaitsMs.length > 50) this.recentWaitsMs.shift()
    }
    this.pairQuick(seated, cadence, RESUME_GRACE_MS)
  }

  private pairQuick(seated: Waiter[], cadence: boolean, holdMs: number): string {
    const code = `q${++this.quickSeq}`
    const players = seated.length
    const room = this.makeSession(players, cadence, { quick: true })
    room.holdMs = holdMs
    room.seats = seated.map((e) => e.conn)
    room.payloads = seated.map((e) => e.payload)
    this.sessions.set(code, room)
    this.startRoom(code, room)
    return code
  }

  private makeSession(players: number, cadence: boolean, opts: Session['opts']): Session {
    return {
      players, cadence, opts,
      seats: new Array<string | null>(players).fill(null),
      payloads: new Array<unknown>(players).fill(null), tokens: null,
      recv: new Array<number>(players).fill(0),
      down: new Array<number | null>(players).fill(null),
      gone: new Array<boolean>(players).fill(false), log: [], holdMs: RESUME_GRACE_MS,
    }
  }

  private startRoom(code: string, room: Session): void {
    const seed = (this.deps.random() * 0xffffffff) >>> 0
    const hostStarts = this.deps.random() < 0.5
    room.tokens = Array.from({ length: room.players }, (_, side) => {
      const token = this.uuid()
      this.resumeIndex.set(token, { code, side })
      return token
    })
    for (let s = 0; s < room.players; s++) {
      const id = room.seats[s]
      const c = id ? this.clients.get(id) : undefined
      if (!c) continue
      c.roomCode = code
      c.cadence = room.cadence
      const m = {
        t: 'matched', seed, hostStarts, youAre: s, token: room.tokens[s],
        players: room.players, opps: room.payloads,
      } as RelayMatched
      if (room.players === 2) m.opp = room.payloads[s === 0 ? 1 : 0] as RelayMatched['opp']
      this.send(c.id, m)
    }
  }

  private resume(c: Client, msg: Extract<RelayClientMessage, { t: 'resume' }>, now: number): void {
    const ref = this.resumeIndex.get(msg.token)
    const room = ref ? this.sessions.get(ref.code) : undefined
    if (!ref || !room) return this.sendError(c.id, 'resume expired', 'resume expired')
    const side = ref.side
    const deadline = room.down[side]
    if (deadline !== null && now >= deadline) this.endSeat(ref.code, room, side)
    if (room.gone[side]) return this.sendError(c.id, 'resume expired', 'resume expired')

    const current = room.seats[side]
    room.down[side] = null
    // Rebind before closing the old connection so its cleanup cannot arm a
    // deadline for the new occupant of this seat.
    room.seats[side] = c.id
    c.roomCode = ref.code
    c.cadence = room.cadence
    const old = current && current !== c.id ? this.clients.get(current) : undefined
    if (old) {
      old.roomCode = null
      old.cadence = false
      this.closeClient(old)
    }

    const have = new Array<number>(room.players).fill(0)
    if (Array.isArray(msg.have)) {
      for (let s = 0; s < room.players; s++) have[s] = msg.have[s] ?? 0
    } else if (msg.have !== undefined) have.fill(msg.have)
    this.send(c.id, { t: 'resumed', ack: room.recv[side] })
    for (const e of room.log) {
      if (e.side !== side && e.n > have[e.side]) this.send(c.id, { t: 'act', a: e.a, n: e.n, from: e.side })
    }
    if (room.players === 2) this.broadcast(room, { t: 'opp_back' }, side)
    else this.broadcast(room, { t: 'player_back', seat: side }, side)
    this.ext?.seatResumed({ session: ref.code, seat: side, conn: c.id })
  }

  private uuid(): string {
    const bytes = Array.from({ length: 16 }, () => Math.floor(this.deps.random() * 256))
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  private newCode(): string | null {
    for (let i = 0; i < 50; i++) {
      const code = String(1000 + Math.floor(this.deps.random() * 9000))
      if (!this.sessions.has(code)) return code
    }
    return null
  }

  private rateLimited(c: Client, now: number): boolean {
    const times = c.msgTimes
    while (times.length && now - times[0] > RATE_MINUTE_WINDOW_MS) times.shift()
    times.push(now)
    if (times.length > (c.cadence ? CADENCE_RATE_PER_MIN : RATE_PER_MIN)) return true
    let inSec = 0
    for (let i = times.length - 1; i >= 0 && now - times[i] <= RATE_SECOND_WINDOW_MS; i--) inSec++
    return inSec > (c.cadence ? CADENCE_RATE_PER_SEC : RATE_PER_SEC)
  }

  private dropInvalid(c: Client): void {
    if (++c.invalidCount >= MAX_INVALID) this.closeClient(c)
  }

  private closeClient(c: Client): void {
    try { (c.conn.close as () => void)() } catch {
      this.deps.log('error', `[relay] close ${c.id} failed`)
    }
    this.disconnect(c.id)
  }

  private dropFromWaitLists(conn: string): void {
    for (const [key, list] of this.waitLists) {
      const i = list.findIndex((e) => e.conn === conn)
      if (i >= 0) list.splice(i, 1)
      if (!list.length) this.waitLists.delete(key)
    }
  }

  private broadcast(room: Session, msg: Record<string, unknown>, except: number): void {
    for (let s = 0; s < room.players; s++) {
      const id = room.seats[s]
      if (s !== except && id) this.send(id, msg)
    }
  }

  private cleanup(c: Client, graceful = false): void {
    this.dropFromWaitLists(c.id)
    for (const [code, room] of [...this.sessions]) {
      const side = room.seats.indexOf(c.id)
      if (side < 0) continue
      if (!graceful && room.tokens) {
        if (room.down[side] !== null) continue
        room.down[side] = this.deps.now() + room.holdMs
        const msg = room.players === 2
          ? { t: 'opp_dropped', graceMs: room.holdMs }
          : { t: 'player_dropped', seat: side, graceMs: room.holdMs }
        this.broadcast(room, msg, side)
        continue
      }
      this.endSeat(code, room, side)
    }
  }

  private endSeat(code: string, room: Session, side: number): void {
    if (room.gone[side]) return
    room.gone[side] = true
    room.down[side] = null
    const id = room.seats[side]
    const c = id ? this.clients.get(id) : undefined
    if (c) { c.roomCode = null; c.cadence = false }
    room.seats[side] = null
    if (room.players === 2) {
      this.broadcast(room, { t: 'opp_left' }, side)
      this.destroyRoom(code, room)
    } else {
      this.broadcast(room, { t: 'player_left', seat: side }, side)
      if (room.gone.filter((gone) => !gone).length <= 1) {
        this.broadcast(room, { t: 'opp_left' }, side)
        this.destroyRoom(code, room)
      }
    }
  }

  private destroyRoom(code: string, room: Session): void {
    room.down.fill(null)
    if (room.tokens) for (const token of room.tokens) this.resumeIndex.delete(token)
    for (const id of room.seats) {
      const c = id ? this.clients.get(id) : undefined
      if (c) { c.roomCode = null; c.cadence = false }
    }
    this.sessions.delete(code)
    this.ext?.sessionEnded(code)
  }
}
