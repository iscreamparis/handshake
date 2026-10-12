// Typed copy of the GameNet relay protocol (see docs/RELAY.md).

export const RELAY_PATH = '/ws'
export const RELAY_TYPE_FIELD = 't'

export const MAX_MSG_BYTES = 4 * 1024
export const MAX_INVALID = 10
export const RATE_PER_SEC = 20
export const RATE_PER_MIN = 400
export const CADENCE_RATE_PER_SEC = 90
export const CADENCE_RATE_PER_MIN = 4000
export const MAX_ROOMS = 200
export const MAX_SOCKETS = 500
export const MAX_PLAYERS = 4
export const MAX_ACT_KEYS = 24
export const MAX_ACT_ITEMS = 512
export const MAX_ACT_DEPTH = 6
export const MAX_LOG_ACTS = 4000
export const MAX_LOG_ACTS_CADENCE = 20_000
export const RESUME_GRACE_MS = 60_000
export const HEARTBEAT_MS = 30_000
export const RATE_SECOND_WINDOW_MS = 1000
export const RATE_MINUTE_WINDOW_MS = 60_000
export const SEQUENCE_MAX = 1_000_000

export const RELAY_CLIENT_TYPES = [
  'create', 'join', 'act', 'bye', 'queue', 'unqueue', 'resume', 'ping',
] as const
export type RelayClientType = typeof RELAY_CLIENT_TYPES[number]

export const RELAY_SERVER_TYPES = [
  'room', 'waiting', 'queued', 'unqueued', 'matched', 'act', 'ack', 'resumed',
  'opp_dropped', 'opp_back', 'opp_left', 'player_dropped', 'player_back',
  'player_left', 'pong', 'error',
] as const
export type RelayServerType = typeof RELAY_SERVER_TYPES[number]
export const RELAY_TYPES = [...RELAY_CLIENT_TYPES, ...RELAY_SERVER_TYPES] as const

export const RELAY_ERROR_CODES = [
  'server full', 'room not found', 'room full', 'bad queue payload',
  'resume expired', 'rate limited',
] as const
export type RelayErrorCode = typeof RELAY_ERROR_CODES[number]

export type RelayPayload = Record<string, unknown> | unknown[] | null
export type RelayHave = number | number[]

export type RelayCreate = { t: 'create'; players?: number; cadence?: boolean; payload?: RelayPayload }
export type RelayJoin = { t: 'join'; code: string; payload?: RelayPayload }
export type RelayAct = { t: 'act'; a: Record<string, unknown> | unknown[]; n?: number }
export type RelayBye = { t: 'bye' }
export type RelayQueue = { t: 'queue'; players?: number; cadence?: boolean; payload?: RelayPayload }
export type RelayUnqueue = { t: 'unqueue' }
export type RelayResume = { t: 'resume'; token: string; have?: RelayHave }
export type RelayPing = { t: 'ping' }
export type RelayClientMessage = RelayCreate | RelayJoin | RelayAct | RelayBye | RelayQueue | RelayUnqueue | RelayResume | RelayPing

export type RelayRoom = { t: 'room'; code: string }
export type RelayWaiting = { t: 'waiting'; seat: number; players: number }
export type RelayQueued = { t: 'queued'; estimateMs: number | null }
export type RelayUnqueued = { t: 'unqueued' }
export type RelayMatched = { t: 'matched'; seed: number; hostStarts: boolean; youAre: number; token: string; players: number; opps: RelayPayload[]; opp?: RelayPayload }
export type RelayActBroadcast = { t: 'act'; a: Record<string, unknown> | unknown[]; n: number; from: number }
export type RelayAck = { t: 'ack'; n: number }
export type RelayResumed = { t: 'resumed'; ack: number }
export type RelayOppDropped = { t: 'opp_dropped'; graceMs: number }
export type RelayOppBack = { t: 'opp_back' }
export type RelayOppLeft = { t: 'opp_left' }
export type RelayPlayerDropped = { t: 'player_dropped'; seat: number; graceMs: number }
export type RelayPlayerBack = { t: 'player_back'; seat: number }
export type RelayPlayerLeft = { t: 'player_left'; seat: number }
export type RelayPong = { t: 'pong' }
export type RelayError = { t: 'error'; reason: RelayErrorCode }
export type RelayServerMessage = RelayRoom | RelayWaiting | RelayQueued | RelayUnqueued | RelayMatched | RelayActBroadcast | RelayAck | RelayResumed | RelayOppDropped | RelayOppBack | RelayOppLeft | RelayPlayerDropped | RelayPlayerBack | RelayPlayerLeft | RelayPong | RelayError
export type RelayMessage = RelayClientMessage | RelayServerMessage

export interface RelayParseError { error: 'bad_message'; message: string }
export interface RelayExtensionMessage { ext: Record<string, unknown> }
export type ParseRelayResult = RelayMessage | RelayExtensionMessage | RelayParseError

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SEQUENCE_MAX
}

function shallowEnough(value: unknown, depth: number): boolean {
  if (depth > MAX_ACT_DEPTH) return false
  if (value === null || typeof value !== 'object') return true
  const entries = Array.isArray(value) ? value : Object.values(value)
  if (entries.length > (Array.isArray(value) ? MAX_ACT_ITEMS : MAX_ACT_KEYS)) return false
  return entries.every((entry) => shallowEnough(entry, depth + 1))
}

function isValidRelayMessage(value: Record<string, unknown>): value is Record<string, unknown> & RelayMessage {
  const type = value.t
  if (typeof type !== 'string' || !(RELAY_CLIENT_TYPES as readonly string[]).includes(type)) return false
  if (type === 'act') {
    return isObject(value.a) || (Array.isArray(value.a) && shallowEnough(value.a, 0))
      ? shallowEnough(value.a, 0) && (value.n === undefined || isSequence(value.n))
      : false
  }
  if (type === 'create' || type === 'queue') {
    if (value.players !== undefined && !(Number.isInteger(value.players) && (value.players as number) >= 2 && (value.players as number) <= MAX_PLAYERS)) return false
    if (value.cadence !== undefined && typeof value.cadence !== 'boolean') return false
    if (type === 'queue' && value.payload !== undefined && value.payload !== null
      && typeof value.payload === 'object' && !shallowEnough(value.payload, 0)) return false
    return true
  }
  if (type === 'join') return typeof value.code === 'string'
  if (type === 'resume') {
    const have = value.have
    const validHave = have === undefined || isSequence(have)
      || (Array.isArray(have) && have.length <= MAX_PLAYERS && have.every(isSequence))
    return typeof value.token === 'string' && value.token.length > 0 && value.token.length <= 64 && validHave
  }
  return true
}

export function parseRelayMessage(raw: string): ParseRelayResult {
  if (typeof raw !== 'string') return { error: 'bad_message', message: 'message must be text' }
  if (Buffer.byteLength(raw) > MAX_MSG_BYTES) return { error: 'bad_message', message: 'message too large' }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { error: 'bad_message', message: 'not JSON' } }
  if (!isObject(parsed)) return { error: 'bad_message', message: 'message must be a JSON object' }
  if (typeof parsed.t === 'string' && !(RELAY_TYPES as readonly string[]).includes(parsed.t)) {
    return { ext: parsed }
  }
  if (!isValidRelayMessage(parsed)) return { error: 'bad_message', message: 'invalid message' }
  return parsed
}

export function encodeRelay(m: RelayMessage): string {
  return JSON.stringify(m)
}

export function relayClaims(frame: string): boolean {
  try {
    const parsed: unknown = JSON.parse(frame)
    return isObject(parsed) && typeof parsed.t === 'string'
      && (RELAY_CLIENT_TYPES as readonly string[]).includes(parsed.t)
  } catch {
    return false
  }
}
