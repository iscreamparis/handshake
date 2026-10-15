// Versioned cloud saves, one row per (player, key) of etc_saves. The server is the source of truth:
// a write names the version it was based on (`base_version`, 0 = create) and is refused with the server copy when
// the version moved (compare-and-set). A replay of the very same write (same base version, same content) is
// answered as a success with `applied: false`. Limits come from etc_settings (src/online/limits.ts).
// The table API has no DELETE: a deleted save stays as a tombstone row (etag '', size 0, data null) whose version keeps
// growing, so a recreate never reuses a version number.

import { createHash } from 'node:crypto'
import { createKeyedLock } from '../economy/lock.ts'
import { StoreError } from '../store/errors.ts'
import type { Row, TableApi } from '../store/tables.ts'
import { byteLength, createWriteLimiter } from '../online/limits.ts'
import type { LimitsHandle } from '../online/limits.ts'

export const SAVE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export interface SaveMeta { key: string; version: number; etag: string; size: number; updated_at: number }
export interface SaveFull extends SaveMeta { data: string }
export interface SaveQuota { used: number; max_bytes: number; keys: number; max_keys: number; max_key_bytes: number }

export interface SavesService {
  list(playerId: string): Promise<{ saves: SaveMeta[]; quota: SaveQuota }>
  /** null when the key has no save. */
  get(playerId: string, key: string): Promise<SaveFull | null>
  /** Throws StoreError('version_conflict', .., SaveFull | null) when the server version differs. */
  put(playerId: string, key: string, baseVersion: number, data: string): Promise<{ save: SaveMeta; applied: boolean }>
  remove(playerId: string, key: string, baseVersion: number): Promise<{ deleted: boolean; applied: boolean }>
}

export const etagOf = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex').slice(0, 16)
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const eq = (field: string, value: unknown) => ({ field, op: 'eq' as const, value })
const isTomb = (r: Row): boolean => r.etag === '' || r.etag === null || r.etag === undefined
const meta = (r: Row): SaveMeta => ({ key: String(r.save_key), version: num(r.version), etag: String(r.etag ?? ''), size: num(r.size), updated_at: num(r.updated_at) })
const full = (r: Row): SaveFull => ({ ...meta(r), data: typeof r.data === 'string' ? r.data : '' })

export function createSavesService(deps: { api: TableApi; limits: LimitsHandle; now?: () => number }): SavesService {
  const { api, limits } = deps
  const now = deps.now ?? Date.now
  const locked = createKeyedLock()
  const allow = createWriteLimiter(now)

  /** Live saves of a player (tombstones excluded). */
  async function rows(playerId: string): Promise<Row[]> {
    const out: Row[] = []
    for (let page = 1; page <= 20; page++) {
      const r = await api.query('etc_saves', { filters: [eq('player_id', playerId)], sort: [{ field: 'save_key', dir: 'asc' }], page, size: 200 })
      out.push(...r)
      if (r.length < 200) break
    }
    return out.filter(r => !isTomb(r))
  }
  const find = async (playerId: string, key: string): Promise<Row | undefined> =>
    (await api.query('etc_saves', { filters: [eq('player_id', playerId), eq('save_key', key)], size: 1 }))[0]

  function checkKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || !SAVE_KEY_RE.test(key)) throw new StoreError('bad_argument', 'Invalid save key')
  }
  function checkBase(v: unknown): asserts v is number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new StoreError('bad_argument', 'Invalid base_version')
  }

  return {
    async list(playerId) {
      const l = await limits.current()
      const all = await rows(playerId)
      return {
        saves: all.map(meta),
        quota: { used: all.reduce((a, r) => a + num(r.size), 0), max_bytes: l.savesQuotaBytes, keys: all.length, max_keys: l.savesMaxKeys, max_key_bytes: l.savesMaxBytes },
      }
    },

    async get(playerId, key) {
      checkKey(key)
      const r = await find(playerId, key)
      return r && !isTomb(r) ? full(r) : null
    },

    async put(playerId, key, baseVersion, data) {
      checkKey(key)
      checkBase(baseVersion)
      if (typeof data !== 'string') throw new StoreError('bad_argument', 'data must be a string')
      return locked([`save:${playerId}`], async () => {
        const l = await limits.current()
        const size = byteLength(data)
        const etag = etagOf(data)
        const row = await find(playerId, key)
        const live = row && !isTomb(row) ? row : undefined
        // A replay of the write that produced the current version is a success, whatever the limits say now.
        if (live && num(live.version) === baseVersion + 1 && live.etag === etag) return { save: meta(live), applied: false }
        // A missing or deleted save is "version 0" for the client (a tombstone also accepts its own version).
        const expected = live ? num(live.version) : 0
        if (baseVersion !== expected && !(row && !live && baseVersion === num(row.version))) {
          throw new StoreError('version_conflict', 'Server version differs', live ? full(live) : null)
        }
        if (size > l.savesMaxBytes) throw new StoreError('too_large', 'Save too large')
        if (!allow(`s:${playerId}`, l.savesWritesPerMinute)) throw new StoreError('rate_limited', 'Too many writes')
        const others = (await rows(playerId)).filter(r => r.save_key !== key)
        if (!live && others.length >= l.savesMaxKeys) throw new StoreError('quota_exceeded', 'Too many save keys')
        if (others.reduce((a, r) => a + num(r.size), 0) + size > l.savesQuotaBytes) throw new StoreError('quota_exceeded', 'Save quota exceeded')
        const t = now()
        if (!row) {
          const made = await api.insert('etc_saves', { player_id: playerId, save_key: key, version: 1, etag, size, data, created_at: t, updated_at: t })
          if (made === 'conflict') { // another instance created it first
            const r = await find(playerId, key)
            throw new StoreError('version_conflict', 'Server version differs', r && !isTomb(r) ? full(r) : null)
          }
          // the generic table API drops created_at / updated_at on insert (system columns): stamp updated_at with an update
          await api.update('etc_saves', made.row.id as number, { updated_at: t })
          return { save: { key, version: 1, etag, size, updated_at: t }, applied: true }
        }
        const version = num(row.version) + 1
        await api.update('etc_saves', row.id as number, { version, etag, size, data, updated_at: t })
        return { save: { key, version, etag, size, updated_at: t }, applied: true }
      })
    },

    async remove(playerId, key, baseVersion) {
      checkKey(key)
      checkBase(baseVersion)
      return locked([`save:${playerId}`], async () => {
        const row = await find(playerId, key)
        if (!row || isTomb(row)) return { deleted: false, applied: false }
        if (num(row.version) !== baseVersion) throw new StoreError('version_conflict', 'Server version differs', full(row))
        await api.update('etc_saves', row.id as number, { version: baseVersion + 1, etag: '', size: 0, data: null, updated_at: now() })
        return { deleted: true, applied: true }
      })
    },
  }
}
