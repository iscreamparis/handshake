// Transport-agnostic room hub: rooms, lobby state and signaling relay.
// No network code here; all time comes from deps.now() or tick(nowMs).

import type { Config } from './config.ts'
import type { ClientMessage, ErrorCode, LocalPlayer, Member, Rid, RoomSettings, ServerMessage } from './protocol.ts'
import { DEFAULT_SETTINGS, MAX_HUMANS, MAX_MACHINES, PROTOCOL_VERSION, encode, parseClientMessage } from './protocol.ts'
import { generateRoomCode, normalizeRoomCode } from './codes.ts'
import { TokenBucket } from './ratelimit.ts'
import { iceServersFor } from './turn.ts'

export interface ClientConn { send(text: string): void; close(code: number, reason: string): void }
export interface HubDeps { now(): number; random(): number; seed(): number; log(level: string, msg: string): void }

const RATE_PER_SEC = 40
const RATE_BURST = 80
const HELLO_TIMEOUT_MS = 10000
const IDLE_LOBBY_MS = 30 * 60 * 1000
const RATE_ABUSE_MS = 5000

interface Client {
  id: string
  conn: ClientConn
  connectedAt: number
  hello: boolean
  game: string
  name: string
  bucket: TokenBucket
  room: Room | null
  peer: number
  players: LocalPlayer[]
}

interface Room {
  code: string
  game: string
  owner: number
  status: 'lobby' | 'racing'
  settings: RoomSettings
  members: Map<number, Client>
  lastActivity: number
  seed: number
}

export class RoomHub {
  cfg: Config
  deps: HubDeps
  clients = new Map<string, Client>()
  rooms = new Map<string, Room>()
  counter = 0

  constructor(cfg: Config, deps: HubDeps) {
    this.cfg = cfg
    this.deps = deps
  }

  connect(conn: ClientConn): string {
    if (this.clients.size >= this.cfg.maxClients) {
      conn.send(encode({ t: 'error', code: 'server_full', message: 'server is full' }))
      conn.close(1013, 'server_full')
      return ''
    }
    this.counter += 1
    const hex = Math.floor(this.deps.random() * 0x100000000).toString(16).padStart(8, '0')
    const id = `c${this.counter}-${hex}`
    this.clients.set(id, {
      id, conn, connectedAt: this.deps.now(), hello: false, game: '', name: '',
      bucket: new TokenBucket(RATE_PER_SEC, RATE_BURST), room: null, peer: -1, players: [],
    })
    return id
  }

  message(clientId: string, raw: string): void {
    const c = this.clients.get(clientId)
    if (!c) return
    let reqRid: Rid | undefined
    try {
      const now = this.deps.now()
      if (!c.bucket.take(now)) {
        this.error(c, 'rate_limited', 'too many messages')
        return
      }
      const m = parseClientMessage(raw)
      if ('error' in m) {
        this.error(c, m.error, m.message, m.rid)
        if (m.error === 'too_large') this.closeClient(c, 4009, 'too_large')
        return
      }
      reqRid = m.rid
      if (c.room) c.room.lastActivity = now
      this.dispatch(c, m, now)
    } catch (e) {
      this.deps.log('error', `[hub] message from ${c.id} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      if (this.clients.has(c.id)) this.error(c, 'internal', 'internal server error', reqRid)
    }
  }

  disconnect(clientId: string): void {
    const c = this.clients.get(clientId)
    if (!c) return
    this.clients.delete(clientId)
    this.removeFromRoom(c)
  }

  tick(nowMs: number): void {
    for (const c of [...this.clients.values()]) {
      if (!c.hello && nowMs - c.connectedAt >= HELLO_TIMEOUT_MS) {
        this.closeClient(c, 4000, 'hello_timeout')
      } else if (c.bucket.overSinceMs !== null && nowMs - c.bucket.overSinceMs >= RATE_ABUSE_MS) {
        this.closeClient(c, 4008, 'rate_limited')
      }
    }
    for (const room of [...this.rooms.values()]) {
      if (room.status !== 'lobby' || nowMs - room.lastActivity < IDLE_LOBBY_MS) continue
      this.rooms.delete(room.code)
      const members = [...room.members.values()]
      room.members.clear()
      for (const c of members) {
        c.room = null
        this.closeClient(c, 1000, 'idle')
      }
    }
  }

  stats(): { rooms: number; clients: number } {
    return { rooms: this.rooms.size, clients: this.clients.size }
  }

  private dispatch(c: Client, m: ClientMessage, now: number): void {
    if (!c.hello) {
      if (m.t !== 'hello') return this.error(c, 'hello_required', 'send hello first', m.rid)
      if (m.v !== PROTOCOL_VERSION) {
        this.error(c, 'bad_version', `protocol version ${PROTOCOL_VERSION} required`, m.rid)
        this.closeClient(c, 4001, 'bad_version')
        return
      }
      c.hello = true
      c.game = m.game
      c.name = m.name
      this.send(c, {
        t: 'welcome', ...rid(m.rid), v: 1, client: c.id,
        iceServers: iceServersFor(c.id, this.cfg, Math.floor(now / 1000)), maxHumans: 8, maxLocal: 4,
      })
      return
    }
    switch (m.t) {
      case 'hello': return this.error(c, 'bad_message', 'hello already received', m.rid)
      case 'create': return this.onCreate(c, m.players, m.settings, m.rid, now)
      case 'join': return this.onJoin(c, m.code, m.players, m.rid, now)
      case 'leave': {
        if (!c.room) return this.error(c, 'not_in_room', 'not in a room', m.rid)
        this.send(c, { t: 'left', ...rid(m.rid) })
        this.removeFromRoom(c)
        return
      }
      case 'players': {
        const room = c.room
        if (!room) return this.error(c, 'not_in_room', 'not in a room', m.rid)
        if (room.status !== 'lobby') return this.error(c, 'room_started', 'the race has started', m.rid)
        if (humans(room) - c.players.length + m.players.length > MAX_HUMANS) return this.error(c, 'room_full', 'too many players', m.rid)
        c.players = m.players
        room.lastActivity = now
        return this.broadcastRoom(room, c, m.rid)
      }
      case 'settings': {
        const room = c.room
        if (!room) return this.error(c, 'not_in_room', 'not in a room', m.rid)
        if (room.owner !== c.peer) return this.error(c, 'not_owner', 'only the owner can do that', m.rid)
        if (room.status !== 'lobby') return this.error(c, 'room_started', 'the race has started', m.rid)
        room.settings = { ...m.settings }
        room.lastActivity = now
        return this.broadcastRoom(room, c, m.rid)
      }
      case 'start': {
        const room = c.room
        if (!room) return this.error(c, 'not_in_room', 'not in a room', m.rid)
        if (room.owner !== c.peer) return this.error(c, 'not_owner', 'only the owner can do that', m.rid)
        if (room.status !== 'lobby') return this.error(c, 'room_started', 'the race has started', m.rid)
        room.status = 'racing'
        room.seed = this.deps.seed() >>> 0
        room.lastActivity = now
        const members = memberList(room)
        for (const target of room.members.values()) {
          this.send(target, {
            t: 'started', ...(target === c ? rid(m.rid) : {}),
            code: room.code, seed: room.seed, settings: { ...room.settings }, members,
          })
        }
        return
      }
      case 'end': {
        const room = c.room
        if (!room) return this.error(c, 'not_in_room', 'not in a room', m.rid)
        if (room.owner !== c.peer) return this.error(c, 'not_owner', 'only the owner can do that', m.rid)
        if (room.status !== 'racing') return this.error(c, 'bad_message', 'the room is not racing', m.rid)
        room.status = 'lobby'
        room.lastActivity = now
        return this.broadcastRoom(room, c, m.rid)
      }
      case 'signal': {
        const room = c.room
        if (!room) return this.error(c, 'not_in_room', 'not in a room', m.rid)
        const target = room.members.get(m.to)
        if (!target || target === c) return this.error(c, 'peer_not_found', `no peer ${m.to} in this room`, m.rid)
        this.send(target, { t: 'signal', from: c.peer, data: m.data })
        return
      }
      case 'ping':
        return this.send(c, { t: 'pong', ...rid(m.rid), id: m.id })
    }
  }

  private onCreate(c: Client, players: LocalPlayer[], settings: RoomSettings | undefined, r: Rid | undefined, now: number): void {
    if (c.room) return this.error(c, 'already_in_room', 'already in a room', r)
    if (this.rooms.size >= this.cfg.maxRooms) return this.error(c, 'server_full', 'no room available on this server', r)
    const code = generateRoomCode(this.deps.random, (k) => this.rooms.has(k))
    const room: Room = {
      code, game: c.game, owner: 0, status: 'lobby', settings: { ...(settings ?? DEFAULT_SETTINGS) },
      members: new Map(), lastActivity: now, seed: 0,
    }
    this.rooms.set(code, room)
    c.room = room
    c.peer = 0
    c.players = players
    room.members.set(0, c)
    this.send(c, this.roomMessage(room, c, r))
  }

  private onJoin(c: Client, rawCode: string, players: LocalPlayer[], r: Rid | undefined, now: number): void {
    if (c.room) return this.error(c, 'already_in_room', 'already in a room', r)
    const code = normalizeRoomCode(rawCode)
    const room = code === null ? undefined : this.rooms.get(code)
    if (!room) return this.error(c, 'room_not_found', 'no room with that code', r)
    if (room.game !== c.game) return this.error(c, 'game_mismatch', 'the room runs a different game version', r)
    if (room.status !== 'lobby') return this.error(c, 'room_started', 'the race has started', r)
    if (room.members.size + 1 > MAX_MACHINES || humans(room) + players.length > MAX_HUMANS) {
      return this.error(c, 'room_full', 'the room is full', r)
    }
    let peer = 0
    while (room.members.has(peer)) peer++
    c.room = room
    c.peer = peer
    c.players = players
    room.members.set(peer, c)
    room.lastActivity = now
    this.broadcastRoom(room, c, r)
  }

  private removeFromRoom(c: Client): void {
    const room = c.room
    if (!room) return
    c.room = null
    room.members.delete(c.peer)
    const leftPeer = c.peer
    c.peer = -1
    c.players = []
    if (room.members.size === 0) {
      this.rooms.delete(room.code)
      return
    }
    if (room.owner === leftPeer) room.owner = Math.min(...room.members.keys())
    room.lastActivity = this.deps.now()
    for (const target of room.members.values()) this.send(target, { t: 'peerLeft', peer: leftPeer })
    this.broadcastRoom(room, null, undefined)
  }

  private broadcastRoom(room: Room, requester: Client | null, r: Rid | undefined): void {
    for (const target of room.members.values()) {
      this.send(target, this.roomMessage(room, target, target === requester ? r : undefined))
    }
  }

  private roomMessage(room: Room, target: Client, r: Rid | undefined): ServerMessage {
    return {
      t: 'room', ...rid(r), code: room.code, you: target.peer, owner: room.owner, status: room.status,
      members: memberList(room), settings: { ...room.settings }, humans: humans(room),
    }
  }

  private closeClient(c: Client, code: number, reason: string): void {
    try {
      c.conn.close(code, reason)
    } catch (e) {
      this.deps.log('error', `[hub] close ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.disconnect(c.id)
  }

  private error(c: Client, code: ErrorCode, message: string, r?: Rid): void {
    this.send(c, { t: 'error', ...rid(r), code, message })
  }

  private send(c: Client, m: ServerMessage): void {
    try {
      c.conn.send(encode(m))
    } catch (e) {
      this.deps.log('error', `[hub] send to ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

function rid(r: Rid | undefined): { rid?: Rid } {
  return r === undefined ? {} : { rid: r }
}

function humans(room: Room): number {
  let n = 0
  for (const c of room.members.values()) n += c.players.length
  return n
}

function memberList(room: Room): Member[] {
  return [...room.members.values()]
    .sort((a, b) => a.peer - b.peer)
    .map((c) => ({ peer: c.peer, name: c.name, players: c.players.map((p) => ({ name: p.name, build: { ...p.build } })) }))
}
