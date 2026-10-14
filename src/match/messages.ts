import type { Outcome } from '../hooks.ts'
import type { Provider, QueueName } from '../store/types.ts'
import { RELAY_CLIENT_TYPES, RELAY_SERVER_TYPES, RELAY_TYPE_FIELD } from '../relay/protocol.ts'

export const ECONOMY_CLIENT_TYPES = ['eco_get', 'eco_products', 'eco_reward', 'eco_buy', 'eco_open', 'eco_wavedash', 'eco_stripe'] as const
export const ECONOMY_SERVER_TYPES = ['eco_state', 'eco_products', 'eco_reward', 'eco_bought', 'eco_opened', 'eco_purchase', 'eco_checkout'] as const
export const MATCH_CLIENT_TYPES = ['auth', 'match_queue', 'match_unqueue', 'result', ...ECONOMY_CLIENT_TYPES] as const
export const MATCH_SERVER_TYPES = ['authed', 'match_queued', 'match_unqueued', 'match', 'result_ack', 'match_end', ...ECONOMY_SERVER_TYPES] as const
export const MATCH_ERROR_CODES = [
  'auth_required', 'already_authed', 'auth_failed', 'auth_unavailable',
  'already_queued', 'not_queued', 'in_match', 'ranked_busy',
  'resident_cannot_queue', 'bad_queue', 'unknown_match', 'already_reported',
  'store_unavailable',
  'economy_unavailable', 'insufficient_funds', 'no_packs', 'tx_conflict', 'unknown_product', 'unknown_reward', 'unknown_pack',
  'purchase_refunded', 'bad_receipt', 'receipt_mismatch', 'not_production', 'bad_return_url', 'payment_unavailable',
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
  | { t: 'eco_get'; op?: string }
  | { t: 'eco_products'; op?: string }
  | { t: 'eco_reward'; op?: string; reward_id: string }
  | { t: 'eco_buy'; op: string; product: string; qty: number }
  | { t: 'eco_open'; op: string; pack_type: string }
  | { t: 'eco_wavedash'; op?: string; receipt_jwt: string; user_jwt?: string }
  | { t: 'eco_stripe'; op?: string; product: string; return_url: string }

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

export type EconomyClientMessage = Extract<MatchClientMessage, { t: typeof ECONOMY_CLIENT_TYPES[number] }>
export function isEconomyMessage(m: MatchClientMessage): m is EconomyClientMessage {
  return (ECONOMY_CLIENT_TYPES as readonly string[]).includes(m.t)
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
    case 'eco_get': case 'eco_products': case 'eco_reward': case 'eco_buy': case 'eco_open': case 'eco_wavedash': case 'eco_stripe':
      return parseEconomy(type, value)
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

const ID = /^[A-Za-z0-9_:.-]{1,96}$/
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max

function parseEconomy(type: typeof ECONOMY_CLIENT_TYPES[number], v: Record<string, unknown>): MatchClientMessage | MatchParseError {
  const opField = v.op
  if (opField !== undefined && !(typeof opField === 'string' && /^[A-Za-z0-9_:.-]{1,64}$/.test(opField))) return bad(`${type}.op must be 1..64 chars of A-Za-z0-9_:.-`)
  const op = opField as string | undefined
  const withOp = op === undefined ? {} : { op }
  switch (type) {
    case 'eco_get': return { t: 'eco_get', ...withOp }
    case 'eco_products': return { t: 'eco_products', ...withOp }
    case 'eco_reward':
      if (!(typeof v.reward_id === 'string' && /^[A-Za-z0-9:_.-]{1,96}$/.test(v.reward_id))) return bad('eco_reward.reward_id invalid')
      return { t: 'eco_reward', ...withOp, reward_id: v.reward_id }
    case 'eco_buy': {
      if (op === undefined) return bad('eco_buy.op required')
      if (!(typeof v.product === 'string' && ID.test(v.product))) return bad('eco_buy.product invalid')
      const qty = v.qty === undefined ? 1 : v.qty
      if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty < 1 || qty > 100) return bad('eco_buy.qty must be an integer 1..100')
      return { t: 'eco_buy', op, product: v.product, qty }
    }
    case 'eco_open':
      if (op === undefined) return bad('eco_open.op required')
      if (!(typeof v.pack_type === 'string' && ID.test(v.pack_type))) return bad('eco_open.pack_type invalid')
      return { t: 'eco_open', op, pack_type: v.pack_type }
    case 'eco_wavedash': {
      if (!str(v.receipt_jwt, 3000)) return bad('eco_wavedash.receipt_jwt must be 1..3000 chars')
      if (v.user_jwt !== undefined && !str(v.user_jwt, 3000)) return bad('eco_wavedash.user_jwt must be 1..3000 chars')
      return { t: 'eco_wavedash', ...withOp, receipt_jwt: v.receipt_jwt, ...(v.user_jwt !== undefined ? { user_jwt: v.user_jwt as string } : {}) }
    }
    case 'eco_stripe': {
      if (!(typeof v.product === 'string' && ID.test(v.product))) return bad('eco_stripe.product invalid')
      if (!str(v.return_url, 400)) return { error: 'bad_message', message: 'eco_stripe.return_url must be 1..400 chars' }
      return { t: 'eco_stripe', ...withOp, product: v.product, return_url: v.return_url }
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
