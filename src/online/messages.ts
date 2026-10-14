// Wire messages of the online data: cloud saves, stats + achievements, player content (UGC). docs/CONTRACT.md r5.
// Every message needs `auth`. A message that mutates takes an `op` (1..64 chars of A-Za-z0-9_:.-) where replay safety matters.

export const SAVES_CLIENT_TYPES = ['save_list', 'save_get', 'save_put', 'save_delete'] as const
export const ACH_CLIENT_TYPES = ['ach_list', 'stats_get', 'stat_report', 'ach_ack'] as const
export const UGC_CLIENT_TYPES = ['ugc_create', 'ugc_update', 'ugc_list', 'ugc_get', 'ugc_delete'] as const
export const ONLINE_CLIENT_TYPES = [...SAVES_CLIENT_TYPES, ...ACH_CLIENT_TYPES, ...UGC_CLIENT_TYPES] as const
export const ONLINE_SERVER_TYPES = [
  'save_list', 'save_data', 'save_ok', 'save_conflict', 'save_deleted',
  'ach_list', 'stats', 'stat_value', 'ach_acked', 'ach_unlocked',
  'ugc_saved', 'ugc_list', 'ugc_item', 'ugc_deleted',
] as const
export const ONLINE_ERROR_CODES = [
  'online_unavailable', 'version_conflict', 'too_large', 'quota_exceeded', 'forbidden', 'rate_limited', 'not_found', 'unknown_stat', 'stat_not_writable',
] as const

export type OnlineClientType = typeof ONLINE_CLIENT_TYPES[number]
export interface OnlineClientMessage { t: OnlineClientType; op?: string; [field: string]: unknown }
export type OnlineParse = OnlineClientMessage | { error: 'bad_message'; message: string }

const OP_RE = /^[A-Za-z0-9_:.-]{1,64}$/
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const STAT_RE = /^[a-z0-9_]{1,64}$/
const bad = (message: string): { error: 'bad_message'; message: string } => ({ error: 'bad_message', message })
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

export function isOnlineClientType(v: unknown): v is OnlineClientType {
  return typeof v === 'string' && (ONLINE_CLIENT_TYPES as readonly string[]).includes(v)
}

export function parseOnlineMessage(type: OnlineClientType, v: Record<string, unknown>): OnlineParse {
  if (v.op !== undefined && !(typeof v.op === 'string' && OP_RE.test(v.op))) return bad(`${type}.op must be 1..64 chars of A-Za-z0-9_:.-`)
  const op = v.op as string | undefined
  const withOp = op === undefined ? {} : { op }
  switch (type) {
    case 'save_list': case 'ach_list': case 'stats_get':
      return { t: type, ...withOp }
    case 'save_get':
      if (!(typeof v.key === 'string' && KEY_RE.test(v.key))) return bad(`${type}.key invalid`)
      return { t: type, ...withOp, key: v.key }
    case 'save_put':
      if (!(typeof v.key === 'string' && KEY_RE.test(v.key))) return bad('save_put.key invalid')
      if (!isInt(v.base_version) || v.base_version < 0) return bad('save_put.base_version must be an integer >= 0')
      if (typeof v.data !== 'string') return bad('save_put.data must be a string')
      return { t: type, ...withOp, key: v.key, base_version: v.base_version, data: v.data }
    case 'save_delete':
      if (!(typeof v.key === 'string' && KEY_RE.test(v.key))) return bad('save_delete.key invalid')
      if (!isInt(v.base_version) || v.base_version < 0) return bad('save_delete.base_version must be an integer >= 0')
      return { t: type, ...withOp, key: v.key, base_version: v.base_version }
    case 'stat_report':
      if (op === undefined) return bad('stat_report.op required')
      if (!(typeof v.stat === 'string' && STAT_RE.test(v.stat))) return bad('stat_report.stat invalid')
      if (typeof v.value !== 'number' || !Number.isFinite(v.value)) return bad('stat_report.value must be a number')
      return { t: type, op, stat: v.stat, value: v.value }
    case 'ach_ack': {
      if (!Array.isArray(v.codes) || v.codes.length < 1 || v.codes.length > 200 || v.codes.some(c => typeof c !== 'string' || !STAT_RE.test(c))) return bad('ach_ack.codes must be 1..200 achievement codes')
      return { t: type, ...withOp, codes: v.codes as string[] }
    }
    case 'ugc_create': {
      const out: OnlineClientMessage = { t: type, ...withOp }
      for (const f of ['type', 'title', 'description', 'visibility', 'content_type', 'content', 'wavedash_ref']) if (v[f] !== undefined) out[f] = v[f]
      return out
    }
    case 'ugc_update': {
      if (!(typeof v.id === 'string' && v.id.length <= 64)) return bad('ugc_update.id invalid')
      if (v.base_version !== undefined && !(isInt(v.base_version) && v.base_version >= 1)) return bad('ugc_update.base_version must be an integer >= 1')
      const out: OnlineClientMessage = { t: type, ...withOp, id: v.id }
      for (const f of ['type', 'title', 'description', 'visibility', 'content_type', 'content', 'wavedash_ref', 'base_version']) if (v[f] !== undefined) out[f] = v[f]
      return out
    }
    case 'ugc_list': {
      const out: OnlineClientMessage = { t: type, ...withOp }
      for (const f of ['owner', 'type', 'visibility', 'cursor']) {
        if (v[f] === undefined) continue
        if (typeof v[f] !== 'string' || (v[f] as string).length > 64) return bad(`ugc_list.${f} invalid`)
        out[f] = v[f]
      }
      if (v.limit !== undefined) {
        if (!isInt(v.limit) || v.limit < 1 || v.limit > 50) return bad('ugc_list.limit must be an integer 1..50')
        out.limit = v.limit
      }
      return out
    }
    case 'ugc_get': case 'ugc_delete':
      if (!(typeof v.id === 'string' && v.id.length <= 64)) return bad(`${type}.id invalid`)
      return { t: type, ...withOp, id: v.id }
  }
}
