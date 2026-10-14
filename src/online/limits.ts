// Per-game limits of the online data (saves, UGC) and the small helpers shared by the three services.
// The limits are DATA: rows of etc_settings (keys below), cached 30 s; a missing or invalid value falls back to the default.

import type { Row, TableApi } from '../store/tables.ts'

export interface OnlineLimits {
  savesMaxBytes: number
  savesQuotaBytes: number
  savesMaxKeys: number
  savesWritesPerMinute: number
  ugcMaxBytes: number
  ugcQuotaBytes: number
  ugcMaxItems: number
  ugcWritesPerMinute: number
}

export const LIMIT_KEYS: Record<keyof OnlineLimits, { key: string; def: number }> = {
  savesMaxBytes: { key: 'saves.max_bytes', def: 196_608 },
  savesQuotaBytes: { key: 'saves.quota_bytes', def: 2_097_152 },
  savesMaxKeys: { key: 'saves.max_keys', def: 32 },
  savesWritesPerMinute: { key: 'saves.writes_per_minute', def: 60 },
  ugcMaxBytes: { key: 'ugc.max_bytes', def: 196_608 },
  ugcQuotaBytes: { key: 'ugc.quota_bytes', def: 4_194_304 },
  ugcMaxItems: { key: 'ugc.max_items', def: 100 },
  ugcWritesPerMinute: { key: 'ugc.writes_per_minute', def: 30 },
}

export const DEFAULT_LIMITS: OnlineLimits = Object.fromEntries(Object.entries(LIMIT_KEYS).map(([k, v]) => [k, v.def])) as unknown as OnlineLimits

export interface LimitsHandle { current(): Promise<OnlineLimits> }

export function createLimits(api: TableApi, now: () => number, ttlMs = 30_000): LimitsHandle {
  let at = -Infinity
  let value = DEFAULT_LIMITS
  return {
    async current() {
      if (now() - at < ttlMs) return value
      const keys = Object.values(LIMIT_KEYS).map(v => v.key)
      let rows: Row[] = []
      try { rows = await api.query('etc_settings', { filters: [{ field: 'key', op: 'in', values: keys }], size: 50 }) } catch { return value }
      const next: Record<string, number> = {}
      for (const [name, spec] of Object.entries(LIMIT_KEYS)) {
        const row = rows.find(r => r.key === spec.key)
        const n = row ? Number(row.value) : NaN
        next[name] = Number.isSafeInteger(n) && n >= 0 ? n : spec.def
      }
      value = next as unknown as OnlineLimits
      at = now()
      return value
    },
  }
}

/** Sliding one-minute write counter per key (one Handshake instance). 0 = no limit. */
export function createWriteLimiter(now: () => number): (key: string, perMinute: number) => boolean {
  const hits = new Map<string, number[]>()
  return (key, perMinute) => {
    if (perMinute <= 0) return true
    const t = now()
    const recent = (hits.get(key) ?? []).filter(x => t - x < 60_000)
    if (recent.length >= perMinute) { hits.set(key, recent); return false }
    recent.push(t)
    hits.set(key, recent)
    return true
  }
}

export const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')
