import type { Outcome } from '../hooks.ts'
import type { Provider, QueueName } from '../store/types.ts'
import { RELAY_CLIENT_TYPES, RELAY_SERVER_TYPES, RELAY_TYPE_FIELD } from '../relay/protocol.ts'

export const MATCH_CLIENT_TYPES = ['auth', 'match_queue', 'match_unqueue', 'result'] as const
export const MATCH_SERVER_TYPES = ['authed', 'match_queued', 'match_unqueued', 'match', 'result_ack', 'match_end'] as const
export const MATCH_ERROR_CODES = [
  'auth_required', 'already_authed', 'auth_failed', 'auth_unavailable',
  'already_queued', 'not_queued', 'in_match', 'ranked_busy',
  'resident_cannot_queue', 'bad_queue', 'unknown_match', 'already_reported',
  'store_unavailable',
] as const

const relayTypes: readonly string[] = [...RELAY_CLIENT_TYPES, ...RELAY_SERVER_TYPES]
for (const type of [...MATCH_CLIENT_TYPES, ...MATCH_SERVER_TYPES]) {
  if (relayTypes.includes(type)) throw new Error(`Match message type '${type}' collides with the relay protocol`)
}

export type MatchClientType = typeof MATCH_CLIENT_TYPES[number]
export type MatchServerType = typeof MATCH_SERVER_TYPES[number]
export type MatchErrorCode = typeof MATCH_ERROR_CODES[number]

export type MatchClientMessage =
  | { t: 'auth'; provider: Provider; token: string; name?: string; game?: string }
  | { t: 'match_queue'; game: string; queue: QueueName }
  | { t: 'match_unqueue' }
  | { t: 'result'; match_id: string; outcome: Outcome }

export type MatchServerMessage =
  | { t: 'authed'; player_id: string; display_name: string; provider: Provider }
  | { t: 'match_queued'; game: string; queue: QueueName; rating: number; games: number; placement: boolean }
  | { t: 'match_unqueued' }
  | {
    t: 'match'; match_id: string; game: string; queue: QueueName; seat: 0 | 1
    opponent: { player_id: string; display_name: string }
  }
  | { t: 'result_ack'; match_id: string }
  | {
    t: 'match_end'; match_id: string; status: 'complete' | 'void' | 'forfeit'; outcome: Outcome | null
    rating?: { before: number; after: number; games: number; placement: boolean }
  }

export type MatchParseError = { error: 'bad_message'; message: string } | { error: 'bad_queue' }
export type ParseMatchResult = MatchClientMessage | MatchParseError | null

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMatchClientType(value: unknown): value is MatchClientType {
  return typeof value === 'string' && (MATCH_CLIENT_TYPES as readonly string[]).includes(value)
}

function bad(message: string): MatchParseError {
  return { error: 'bad_message', message }
}

/** Accepts either a text frame or the relay extension's already parsed object. */
export function parseMatchMessage(raw: string | Record<string, unknown>): ParseMatchResult {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return bad('not JSON') }
  }
  if (!isObject(value)) return bad('message must be a JSON object')
  const type = value[RELAY_TYPE_FIELD]
  if (!isMatchClientType(type)) return null

  switch (type) {
    case 'auth': {
      const { provider, token, name, game } = value
      if (provider !== 'wavedash' && provider !== 'itch' && provider !== 'guest') {
        return bad('auth.provider must be wavedash, itch or guest')
      }
      if (typeof token !== 'string') return bad('auth.token must be a string')
      if (provider === 'guest') {
        if (token.length < 16 || token.length > 128 || /[^A-Za-z0-9_-]/.test(token)) {
          return bad('auth.token must be 16..128 chars of A-Za-z0-9_- for guests')
        }
      } else if (token.length < 1 || token.length > 4096) {
        return bad('auth.token must be 1..4096 chars')
      }
      if (name !== undefined && typeof name !== 'string') return bad('auth.name must be a string')
      if (game !== undefined && (typeof game !== 'string' || game.length < 1 || game.length > 64)) {
        return bad('auth.game must be 1..64 chars')
      }
      const trimmedName = name?.trim()
      const out: { t: 'auth'; provider: Provider; token: string; name?: string; game?: string } = { t: 'auth', provider, token }
      if (trimmedName !== undefined && trimmedName.length >= 3 && trimmedName.length <= 16) out.name = trimmedName
      if (game !== undefined) out.game = game
      return out
    }
    case 'match_queue': {
      const { game, queue } = value
      if (typeof game !== 'string' || game.length < 1 || game.length > 64) {
        return bad('match_queue.game must be 1..64 chars')
      }
      if (queue !== 'quick' && queue !== 'ranked') return { error: 'bad_queue' }
      return { t: 'match_queue', game, queue }
    }
    case 'match_unqueue':
      return { t: 'match_unqueue' }
    case 'result': {
      const { match_id, outcome } = value
      if (typeof match_id !== 'string' || match_id.length < 1 || match_id.length > 128) {
        return bad('result.match_id must be 1..128 chars')
      }
      if (outcome !== 'win' && outcome !== 'loss' && outcome !== 'draw') {
        return bad('result.outcome must be win, loss or draw')
      }
      return { t: 'result', match_id, outcome }
    }
  }
}

export function matchClaims(frame: string): boolean {
  try {
    const value: unknown = JSON.parse(frame)
    return isObject(value) && isMatchClientType(value[RELAY_TYPE_FIELD])
  } catch {
    return false
  }
}
