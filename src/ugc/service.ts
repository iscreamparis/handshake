// Player-made content (levels, mods, maps, screenshots...) registry: etc_ugc, one row per item.
// Content is a bounded text (JSON, plain text or base64) stored in the row; the limits (size per item, items and bytes
// per player, writes per minute) are etc_settings rows (src/online/limits.ts). Rules:
//   * the owner alone updates or deletes an item; anyone reads a PUBLIC item, only the owner reads a PRIVATE one;
//   * `hidden` is the admin's mask (backoffice): a hidden item disappears for everyone but its owner, who still sees it flagged;
//   * the table API has no DELETE: a deleted item is emptied and marked content_type `deleted` (never listed, served or counted again);
//   * lists are paged by cursor (the row id of the last item), newest first.

import { createHash, randomUUID } from 'node:crypto'
import { createKeyedLock } from '../economy/lock.ts'
import { StoreError } from '../store/errors.ts'
import type { Filter, Row, TableApi } from '../store/tables.ts'
import { byteLength, createWriteLimiter } from '../online/limits.ts'
import type { LimitsHandle } from '../online/limits.ts'

export const UGC_TYPES = ['SCREENSHOT', 'VIDEO', 'COMMUNITY', 'GAME_MANAGED', 'OTHER'] as const
export const UGC_VISIBILITY = ['PUBLIC', 'PRIVATE'] as const
export const UGC_CONTENT_TYPES = ['json', 'text', 'base64'] as const
export type UgcType = typeof UGC_TYPES[number]
export type Visibility = typeof UGC_VISIBILITY[number]
export type ContentType = typeof UGC_CONTENT_TYPES[number]

export interface UgcMeta {
  id: string
  owner: string
  type: UgcType
  title: string
  description: string
  visibility: Visibility
  content_type: ContentType
  size: number
  hash: string
  version: number
  wavedash_ref: string | null
  hidden: boolean
  created_at: number
  updated_at: number
}
export interface UgcItem extends UgcMeta { content: string }
export interface UgcInput {
  type?: unknown; title?: unknown; description?: unknown; visibility?: unknown
  content_type?: unknown; content?: unknown; wavedash_ref?: unknown
}
export interface UgcListQuery { owner?: string; type?: string; visibility?: string; cursor?: string; limit?: number }

export interface UgcService {
  /** `op` makes a create idempotent (the same op returns the same item). */
  create(playerId: string, input: UgcInput, op?: string): Promise<{ item: UgcMeta; applied: boolean }>
  update(playerId: string, id: string, patch: UgcInput, baseVersion?: number): Promise<{ item: UgcMeta; applied: boolean }>
  list(viewerId: string, q: UgcListQuery): Promise<{ items: UgcMeta[]; next_cursor: string | null }>
  get(viewerId: string, id: string): Promise<UgcItem>
  remove(playerId: string, id: string): Promise<{ deleted: boolean }>
}

const ID_RE = /^u_[A-Za-z0-9]{8,48}$/
const REF_RE = /^[A-Za-z0-9_:.-]{1,128}$/
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32)
const DELETED = 'deleted'

const meta = (r: Row): UgcMeta => ({
  id: String(r.item_id), owner: String(r.player_id), type: String(r.ugc_type) as UgcType, title: String(r.title ?? ''),
  description: String(r.description ?? ''), visibility: String(r.visibility) as Visibility, content_type: String(r.content_type) as ContentType,
  size: num(r.size), hash: String(r.hash ?? ''), version: num(r.version),
  wavedash_ref: typeof r.wavedash_ref === 'string' && r.wavedash_ref !== '' ? r.wavedash_ref : null,
  hidden: r.hidden === true, created_at: num(r.created_at), updated_at: num(r.updated_at),
})
const isDeleted = (r: Row): boolean => r.content_type === DELETED

export function createUgcService(deps: { api: TableApi; limits: LimitsHandle; now?: () => number }): UgcService {
  const { api, limits } = deps
  const now = deps.now ?? Date.now
  const locked = createKeyedLock()
  const allow = createWriteLimiter(now)

  async function byItemId(id: string): Promise<Row | undefined> {
    if (!ID_RE.test(id)) throw new StoreError('bad_argument', 'Invalid id')
    const r = (await api.query('etc_ugc', { filters: [eq('item_id', id)], size: 1 }))[0]
    return r && !isDeleted(r) ? r : undefined
  }
  async function ownRows(playerId: string): Promise<Row[]> {
    const out: Row[] = []
    for (let page = 1; page <= 20; page++) {
      const r = await api.query('etc_ugc', { filters: [eq('player_id', playerId)], page, size: 200 })
      out.push(...r)
      if (r.length < 200) break
    }
    return out.filter(r => !isDeleted(r))
  }
  /** Can `viewer` see this row at all? (a private item of someone else does not exist for them) */
  const visibleTo = (r: Row, viewer: string): boolean => r.player_id === viewer || (r.visibility === 'PUBLIC' && r.hidden !== true)

  function text(v: unknown, name: string, min: number, max: number): string {
    if (typeof v !== 'string') throw new StoreError('bad_argument', `${name} must be a string`)
    const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (t.length < min || t.length > max) throw new StoreError('bad_argument', `${name} must be ${min}..${max} chars`)
    return t
  }
  function oneOf<T extends string>(v: unknown, list: readonly T[], name: string): T {
    if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw new StoreError('bad_argument', `${name} must be one of ${list.join(', ')}`)
    return v as T
  }
  function checkContent(contentType: ContentType, content: unknown, maxBytes: number): string {
    if (typeof content !== 'string') throw new StoreError('bad_argument', 'content must be a string')
    if (byteLength(content) > maxBytes) throw new StoreError('too_large', 'Content too large')
    if (contentType === 'json') { try { JSON.parse(content) } catch { throw new StoreError('bad_argument', 'content is not valid JSON') } }
    if (contentType === 'base64' && (content.length % 4 !== 0 || !B64_RE.test(content))) throw new StoreError('bad_argument', 'content is not valid base64')
    return content
  }
  function ref(v: unknown): string | null {
    if (v === undefined || v === null || v === '') return null
    if (typeof v !== 'string' || !REF_RE.test(v)) throw new StoreError('bad_argument', 'Invalid wavedash_ref')
    return v
  }

  return {
    async create(playerId, input, op) {
      return locked([`ugc:${playerId}`], async () => {
        const l = await limits.current()
        const type = oneOf(input.type ?? 'COMMUNITY', UGC_TYPES, 'type')
        const title = text(input.title, 'title', 1, 80)
        const description = input.description === undefined ? '' : text(input.description, 'description', 0, 500)
        const visibility = oneOf(input.visibility ?? 'PRIVATE', UGC_VISIBILITY, 'visibility')
        const contentType = oneOf(input.content_type ?? 'json', UGC_CONTENT_TYPES, 'content_type')
        const itemId = op !== undefined ? `u_${sha(`${playerId}:${op}`).slice(0, 24)}` : `u_${randomUUID().replace(/-/g, '')}`
        if (op !== undefined) {
          const prior = (await api.query('etc_ugc', { filters: [eq('item_id', itemId)], size: 1 }))[0]
          if (prior) return { item: meta(prior), applied: false }
        }
        const content = checkContent(contentType, input.content, l.ugcMaxBytes)
        const size = byteLength(content)
        if (!allow(`u:${playerId}`, l.ugcWritesPerMinute)) throw new StoreError('rate_limited', 'Too many writes')
        const own = await ownRows(playerId)
        if (own.length >= l.ugcMaxItems) throw new StoreError('quota_exceeded', 'Too many items')
        if (own.reduce((a, r) => a + num(r.size), 0) + size > l.ugcQuotaBytes) throw new StoreError('quota_exceeded', 'Content quota exceeded')
        const t = now()
        const made = await api.insert('etc_ugc', {
          item_id: itemId, player_id: playerId, ugc_type: type, title, description, visibility, hidden: false, content_type: contentType,
          content, size, hash: sha(content), version: 1, wavedash_ref: ref(input.wavedash_ref), created_at: t, updated_at: t,
        })
        if (made === 'conflict') {
          const prior = (await api.query('etc_ugc', { filters: [eq('item_id', itemId)], size: 1 }))[0]
          if (prior && prior.player_id === playerId) return { item: meta(prior), applied: false }
          throw new StoreError('tx_conflict', 'Item id already used')
        }
        return { item: meta(made.row), applied: true }
      })
    },

    async update(playerId, id, patch, baseVersion) {
      return locked([`ugc:${playerId}`], async () => {
        const l = await limits.current()
        const row = await byItemId(id)
        if (!row || (row.player_id !== playerId && !visibleTo(row, playerId))) throw new StoreError('not_found', 'No such item')
        if (row.player_id !== playerId) throw new StoreError('forbidden', 'Not your item')
        if (baseVersion !== undefined && baseVersion !== num(row.version)) throw new StoreError('version_conflict', 'Server version differs', meta(row))
        const next: Row = {}
        if (patch.title !== undefined) next.title = text(patch.title, 'title', 1, 80)
        if (patch.description !== undefined) next.description = text(patch.description, 'description', 0, 500)
        if (patch.type !== undefined) next.ugc_type = oneOf(patch.type, UGC_TYPES, 'type')
        if (patch.visibility !== undefined) next.visibility = oneOf(patch.visibility, UGC_VISIBILITY, 'visibility')
        if (patch.wavedash_ref !== undefined) next.wavedash_ref = ref(patch.wavedash_ref)
        const newType = patch.content_type !== undefined ? oneOf(patch.content_type, UGC_CONTENT_TYPES, 'content_type') : undefined
        if (patch.content !== undefined || newType !== undefined) {
          const contentType = newType ?? (String(row.content_type) as ContentType)
          const content = checkContent(contentType, patch.content ?? row.content ?? '', l.ugcMaxBytes)
          const size = byteLength(content)
          const others = (await ownRows(playerId)).filter(r => r.item_id !== id)
          if (others.reduce((a, r) => a + num(r.size), 0) + size > l.ugcQuotaBytes) throw new StoreError('quota_exceeded', 'Content quota exceeded')
          Object.assign(next, { content, content_type: contentType, size, hash: sha(content) })
        }
        if (Object.keys(next).length === 0) return { item: meta(row), applied: false }
        if (!allow(`u:${playerId}`, l.ugcWritesPerMinute)) throw new StoreError('rate_limited', 'Too many writes')
        Object.assign(next, { version: num(row.version) + 1, updated_at: now() })
        await api.update('etc_ugc', row.id as number, next)
        return { item: meta({ ...row, ...next }), applied: true }
      })
    },

    async list(viewerId, q) {
      const limit = q.limit === undefined ? 20 : q.limit
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new StoreError('bad_argument', 'limit must be 1..50')
      const filters: Filter[] = []
      const owner = q.owner === 'me' ? viewerId : q.owner
      if (owner !== undefined && owner === viewerId) filters.push(eq('player_id', viewerId))
      else {
        if (owner !== undefined) filters.push(eq('player_id', owner))
        filters.push(eq('visibility', 'PUBLIC'), eq('hidden', false))
      }
      if (q.type !== undefined) filters.push(eq('ugc_type', oneOf(q.type, UGC_TYPES, 'type')))
      if (q.visibility !== undefined) filters.push(eq('visibility', oneOf(q.visibility, UGC_VISIBILITY, 'visibility')))
      if (q.cursor !== undefined) {
        const c = Number(q.cursor)
        if (!/^\d{1,12}$/.test(q.cursor) || !Number.isSafeInteger(c)) throw new StoreError('bad_argument', 'Invalid cursor')
        filters.push({ field: 'id', op: 'lt', value: c })
      }
      const items: UgcMeta[] = []
      let last: number | null = null
      let more = false
      // Deleted rows are skipped here, so keep reading pages until the window is full (bounded).
      let cursorFilters = filters
      for (let round = 0; round < 10 && items.length <= limit; round++) {
        const rows = await api.query('etc_ugc', { filters: cursorFilters, sort: [{ field: 'id', dir: 'desc' }], size: limit + 1 })
        for (const r of rows) {
          if (isDeleted(r)) { last = num(r.id); continue }
          if (items.length === limit) { more = true; break }
          items.push(meta(r)); last = num(r.id)
        }
        if (more || rows.length < limit + 1) break
        cursorFilters = [...filters.filter(f => !(f.field === 'id')), { field: 'id', op: 'lt', value: last! }]
      }
      return { items, next_cursor: more && last !== null ? String(last) : null }
    },

    async get(viewerId, id) {
      const row = await byItemId(id)
      if (!row || !visibleTo(row, viewerId)) throw new StoreError('not_found', 'No such item')
      return { ...meta(row), content: String(row.content ?? '') }
    },

    async remove(playerId, id) {
      return locked([`ugc:${playerId}`], async () => {
        const row = await byItemId(id)
        if (!row || !visibleTo(row, playerId)) throw new StoreError('not_found', 'No such item')
        if (row.player_id !== playerId) throw new StoreError('forbidden', 'Not your item')
        // The table API has no DELETE: the row is emptied and marked deleted (it no longer counts in the quota).
        await api.update('etc_ugc', row.id as number, { content_type: DELETED, content: null, size: 0, visibility: 'PRIVATE', hidden: true, title: '', description: '', updated_at: now() })
        return { deleted: true }
      })
    },
  }
}
