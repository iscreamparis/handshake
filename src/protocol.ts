// Typed copy of the rooms protocol (see PROTOCOL.md).

export const PROTOCOL_VERSION = 1
export const MAX_MESSAGE_BYTES = 65536
export const MAX_HUMANS = 8
export const MAX_MACHINES = 8
export const MAX_LOCAL = 4
export const NAME_MAX = 16
const SIGNAL_MAX_BYTES = 16384

export type ErrorCode =
  | 'bad_message' | 'bad_version' | 'hello_required' | 'game_mismatch' | 'room_not_found'
  | 'room_full' | 'room_started' | 'not_in_room' | 'already_in_room' | 'not_owner'
  | 'bad_players' | 'bad_settings' | 'peer_not_found' | 'rate_limited' | 'server_full'
  | 'too_large' | 'internal'

export const ERROR_CODES: readonly ErrorCode[] = [
  'bad_message', 'bad_version', 'hello_required', 'game_mismatch', 'room_not_found',
  'room_full', 'room_started', 'not_in_room', 'already_in_room', 'not_owner',
  'bad_players', 'bad_settings', 'peer_not_found', 'rate_limited', 'server_full',
  'too_large', 'internal',
]

export interface KartBuildIds { characterId: string; bodyId: string; wheelId: string; gliderId: string }
export interface LocalPlayer { name: string; build: KartBuildIds }
export interface RoomSettings { kind: 'cup' | 'track'; cupId: string; trackId: string; cc: 50 | 100 | 150 | 200; items: boolean }
export interface Member { peer: number; name: string; players: LocalPlayer[] }
export interface RoomListing { code: string; owner: string; humans: number; settings: RoomSettings }
export interface IceServer { urls: string[]; username?: string; credential?: string }
export type SignalData =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { kind: 'ice-end' }

export type Rid = string | number

export type ClientMessage =
  | { t: 'hello'; rid?: Rid; v: number; game: string; name: string }
  | { t: 'create'; rid?: Rid; players: LocalPlayer[]; settings?: RoomSettings; private?: boolean }
  | { t: 'join'; rid?: Rid; code: string; players: LocalPlayer[] }
  | { t: 'list'; rid?: Rid }
  | { t: 'leave'; rid?: Rid }
  | { t: 'players'; rid?: Rid; players: LocalPlayer[] }
  | { t: 'settings'; rid?: Rid; settings: RoomSettings }
  | { t: 'start'; rid?: Rid }
  | { t: 'end'; rid?: Rid }
  | { t: 'signal'; rid?: Rid; to: number; data: SignalData }
  | { t: 'ping'; rid?: Rid; id: number }

export type ServerMessage =
  | { t: 'welcome'; rid?: Rid; v: 1; client: string; iceServers: IceServer[]; maxHumans: 8; maxLocal: 4 }
  | { t: 'room'; rid?: Rid; code: string; you: number; owner: number; status: 'lobby' | 'racing'; members: Member[]; settings: RoomSettings; humans: number; private?: boolean }
  | { t: 'started'; rid?: Rid; code: string; seed: number; settings: RoomSettings; members: Member[] }
  | { t: 'rooms'; rid?: Rid; rooms: RoomListing[] }
  | { t: 'left'; rid?: Rid }
  | { t: 'peerLeft'; peer: number }
  | { t: 'signal'; from: number; data: SignalData }
  | { t: 'pong'; rid?: Rid; id: number }
  | { t: 'error'; rid?: Rid; code: ErrorCode; message: string }

export interface ParseError { error: ErrorCode; rid?: Rid; message: string }

export const DEFAULT_SETTINGS: RoomSettings = { kind: 'cup', cupId: 'sprout', trackId: 'meadow-loop', cc: 150, items: true }

const BUILD_ID = /^[a-z0-9-]{1,24}$/
const SETTINGS_ID = /^[a-z0-9-]{1,32}$/
const CCS = [50, 100, 150, 200]

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function trimName(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length >= 1 && s.length <= max ? s : null
}

function buildId(v: unknown): string | null {
  return typeof v === 'string' && BUILD_ID.test(v) ? v : null
}

export function validatePlayers(v: unknown): LocalPlayer[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_LOCAL) return null
  const out: LocalPlayer[] = []
  for (const p of v) {
    if (!isObj(p) || !isObj(p.build)) return null
    const name = trimName(p.name, NAME_MAX)
    const b = p.build
    const characterId = buildId(b.characterId)
    const bodyId = buildId(b.bodyId)
    const wheelId = buildId(b.wheelId)
    const gliderId = buildId(b.gliderId)
    if (name === null || characterId === null || bodyId === null || wheelId === null || gliderId === null) return null
    out.push({ name, build: { characterId, bodyId, wheelId, gliderId } })
  }
  return out
}

export function validateSettings(v: unknown): RoomSettings | null {
  if (!isObj(v)) return null
  const { kind, cupId, trackId, cc, items } = v
  if (kind !== 'cup' && kind !== 'track') return null
  if (typeof cupId !== 'string' || !SETTINGS_ID.test(cupId)) return null
  if (typeof trackId !== 'string' || !SETTINGS_ID.test(trackId)) return null
  if (typeof cc !== 'number' || !CCS.includes(cc)) return null
  if (typeof items !== 'boolean') return null
  return { kind, cupId, trackId, cc: cc as RoomSettings['cc'], items }
}

function validateSignal(v: unknown): SignalData | null {
  if (!isObj(v)) return null
  let out: SignalData
  if (v.kind === 'offer' || v.kind === 'answer') {
    if (typeof v.sdp !== 'string') return null
    out = { kind: v.kind, sdp: v.sdp }
  } else if (v.kind === 'ice') {
    const { candidate, sdpMid, sdpMLineIndex } = v
    if (typeof candidate !== 'string') return null
    if (sdpMid !== null && typeof sdpMid !== 'string') return null
    if (sdpMLineIndex !== null && !(typeof sdpMLineIndex === 'number' && Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0)) return null
    out = { kind: 'ice', candidate, sdpMid, sdpMLineIndex }
  } else if (v.kind === 'ice-end') {
    out = { kind: 'ice-end' }
  } else {
    return null
  }
  if (Buffer.byteLength(JSON.stringify(v)) > SIGNAL_MAX_BYTES) return null
  return out
}

function fail(error: ErrorCode, message: string, rid?: Rid): ParseError {
  return rid === undefined ? { error, message } : { error, rid, message }
}

export function parseClientMessage(raw: string): ClientMessage | ParseError {
  try {
    if (typeof raw !== 'string') return fail('bad_message', 'message must be text')
    if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return fail('too_large', 'message too large')
    let o: unknown
    try { o = JSON.parse(raw) } catch { return fail('bad_message', 'not JSON') }
    if (!isObj(o)) return fail('bad_message', 'message must be a JSON object')
    const rid: Rid | undefined = typeof o.rid === 'string' || (typeof o.rid === 'number' && Number.isFinite(o.rid)) ? o.rid : undefined
    const withRid = <T extends object>(m: T): T => (rid === undefined ? m : { ...m, rid })
    const bad = (msg: string): ParseError => fail('bad_message', msg, rid)
    switch (o.t) {
      case 'hello': {
        if (typeof o.v !== 'number') return bad('hello.v must be a number')
        if (typeof o.game !== 'string' || o.game.length < 1 || o.game.length > 64) return bad('hello.game must be 1..64 chars')
        const name = trimName(o.name, NAME_MAX)
        if (name === null) return bad('hello.name must be 1..16 chars')
        return withRid({ t: 'hello', v: o.v, game: o.game, name })
      }
      case 'create': {
        if (o.players === undefined) return bad('create.players missing')
        const players = validatePlayers(o.players)
        if (!players) return fail('bad_players', 'invalid players list', rid)
        if (o.private !== undefined && typeof o.private !== 'boolean') return bad('create.private must be a boolean')
        const priv = o.private === true ? { private: true } : {}
        if (o.settings === undefined) return withRid({ t: 'create', players, ...priv })
        const settings = validateSettings(o.settings)
        if (!settings) return fail('bad_settings', 'invalid settings', rid)
        return withRid({ t: 'create', players, settings, ...priv })
      }
      case 'join': {
        if (typeof o.code !== 'string') return bad('join.code must be a string')
        if (o.players === undefined) return bad('join.players missing')
        const players = validatePlayers(o.players)
        if (!players) return fail('bad_players', 'invalid players list', rid)
        return withRid({ t: 'join', code: o.code, players })
      }
      case 'players': {
        if (o.players === undefined) return bad('players.players missing')
        const players = validatePlayers(o.players)
        if (!players) return fail('bad_players', 'invalid players list', rid)
        return withRid({ t: 'players', players })
      }
      case 'settings': {
        if (o.settings === undefined) return bad('settings.settings missing')
        const settings = validateSettings(o.settings)
        if (!settings) return fail('bad_settings', 'invalid settings', rid)
        return withRid({ t: 'settings', settings })
      }
      case 'list': case 'leave': case 'start': case 'end':
        return withRid({ t: o.t })
      case 'signal': {
        const to = o.to
        if (typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to > 7) return bad('signal.to must be 0..7')
        const data = validateSignal(o.data)
        if (!data) return bad('invalid signal data')
        return withRid({ t: 'signal', to, data })
      }
      case 'ping': {
        if (typeof o.id !== 'number' || !Number.isFinite(o.id)) return bad('ping.id must be a finite number')
        return withRid({ t: 'ping', id: o.id })
      }
      default:
        return bad(typeof o.t === 'string' ? `unknown type '${o.t.slice(0, 32)}'` : 'missing t')
    }
  } catch {
    return fail('bad_message', 'invalid message')
  }
}

export function encode(m: ServerMessage): string {
  return JSON.stringify(m)
}
