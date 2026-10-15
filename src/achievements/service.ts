// Stats and achievements of the players, evaluated by the server only.
//
// Data (backoffice, per game): etc_stats (definitions), etc_achievements (catalogue + rule), and per player
// etc_player_stats / etc_player_achievements. The client never unlocks anything: it
//   * reports values of stats flagged `client_writable` (stat_report), and
//   * triggers server events indirectly (a match ends, a pack is opened, a purchase is made).
// Rules (etc_achievements.rule_type):
//   stat   : unlocked when the player's value of `rule_stat` reaches `rule_threshold` (>=, or <= for a `min` stat)
//   event  : unlocked by the first server event `rule_event` whose payload satisfies `rule_filter` (rules.ts)
//   manual : never unlocked by the server (the backoffice grants it)
// Built-in stats are kept by the server for every game (BUILTIN_STATS), whether or not etc_stats defines them.
// Every unlock is one insert guarded by the unique (player, achievement): idempotent. A stat report carries an `op`
// claimed in etc_ledger (op `stat.report`), so a replay changes nothing. Unlocks are also kept `pending` until the
// client confirms it copied them to Wavedash (ack), so a crash of the client never loses a copy.

import { createKeyedLock } from '../economy/lock.ts'
import { StoreError } from '../store/errors.ts'
import type { Row, TableApi } from '../store/tables.ts'
import { matchesFilter, parseFilter } from './rules.ts'

export type Aggregation = 'sum' | 'max' | 'min' | 'last'

export const BUILTIN_STATS: Record<string, Aggregation> = {
  matches_played: 'sum', matches_won: 'sum', matches_lost: 'sum', matches_drawn: 'sum',
  ranked_matches_played: 'sum', ranked_matches_won: 'sum',
  win_streak_current: 'last', win_streak_best: 'max', rating_peak: 'max',
  packs_opened: 'sum', cards_unique: 'max', purchases: 'sum', rewards_claimed: 'sum',
}

export const EVENTS = ['match_end', 'pack_opened', 'purchase', 'reward'] as const
export type EventName = typeof EVENTS[number]

export interface AchievementView {
  code: string
  title: { fr: string; en: string }
  description: { fr: string; en: string }
  secret: boolean
  image: string | null
  unlocked: boolean
  unlocked_at: number | null
  synced: boolean
  progress: { stat: string; value: number; threshold: number } | null
}

export interface StatReportResult { stat: string; value: number; applied: boolean; unlocked: AchievementView[] }

export interface ProgressService {
  list(playerId: string): Promise<{ achievements: AchievementView[]; pending_sync: string[] }>
  stats(playerId: string): Promise<Record<string, number>>
  report(playerId: string, op: string, stat: string, value: number): Promise<StatReportResult>
  /** A server event (match end, pack opened...). `key` makes it idempotent (e.g. the match id). Returns the new unlocks. */
  event(playerId: string, name: EventName, payload: Record<string, unknown>, key?: string): Promise<AchievementView[]>
  /** Marks unlocks as copied to Wavedash. Returns the codes that were pending and are now synced. */
  ack(playerId: string, codes: string[]): Promise<string[]>
  refresh(): Promise<void>
}

interface AchDef {
  code: string; title: { fr: string; en: string }; description: { fr: string; en: string }; secret: boolean; image: string | null
  ruleType: string; ruleStat: string | null; threshold: number; ruleEvent: string | null; filter: string | null; order: number; id: number
}
interface StatDef { code: string; aggregation: Aggregation; clientWritable: boolean; maxDelta: number | null; valueType: 'int' | 'float' }

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const eq = (field: string, value: unknown) => ({ field, op: 'eq' as const, value })
const OP_RE = /^[A-Za-z0-9_:.-]{1,64}$/
const CODE_RE = /^[a-z0-9_]{1,64}$/

export function createProgressService(deps: { api: TableApi; now?: () => number; ttlMs?: number; log?: (level: string, msg: string) => void }): ProgressService {
  const { api } = deps
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? 30_000
  const log = deps.log ?? (() => {})
  const locked = createKeyedLock()

  // --- definitions (cached) ----------------------------------------------------------------------------------
  let defs: { at: number; ach: AchDef[]; stats: Map<string, StatDef> } | null = null
  async function loadDefs(): Promise<{ ach: AchDef[]; stats: Map<string, StatDef> }> {
    if (defs && now() - defs.at < ttl) return defs
    const [achRows, statRows] = await Promise.all([
      api.query('etc_achievements', { filters: [eq('active', true)], sort: [{ field: 'sort_order', dir: 'asc' }, { field: 'id', dir: 'asc' }], size: 500 }),
      api.query('etc_stats', { filters: [eq('active', true)], size: 500 }),
    ])
    const ach: AchDef[] = []
    for (const r of achRows) {
      const code = str(r.code)
      if (!CODE_RE.test(code)) continue
      ach.push({
        code, id: num(r.id), order: num(r.sort_order),
        title: { fr: str(r.title_fr) || str(r.title_en) || code, en: str(r.title_en) || str(r.title_fr) || code },
        description: { fr: str(r.description_fr) || str(r.description_en), en: str(r.description_en) || str(r.description_fr) },
        secret: r.secret === true, image: str(r.image) || null,
        ruleType: str(r.rule_type) || 'stat', ruleStat: str(r.rule_stat) || null, threshold: r.rule_threshold === null || r.rule_threshold === undefined ? 1 : num(r.rule_threshold),
        ruleEvent: str(r.rule_event) || null, filter: str(r.rule_filter) || null,
      })
    }
    const stats = new Map<string, StatDef>()
    for (const [code, aggregation] of Object.entries(BUILTIN_STATS)) stats.set(code, { code, aggregation, clientWritable: false, maxDelta: null, valueType: 'int' })
    for (const r of statRows) {
      const code = str(r.code)
      if (!CODE_RE.test(code)) continue
      const agg = str(r.aggregation) as Aggregation
      const builtin = BUILTIN_STATS[code]
      stats.set(code, {
        code, aggregation: builtin ?? (['sum', 'max', 'min', 'last'].includes(agg) ? agg : 'sum'),
        // a built-in stat is server-owned whatever the row says
        clientWritable: builtin ? false : r.client_writable === true,
        maxDelta: r.max_delta === null || r.max_delta === undefined ? null : num(r.max_delta),
        valueType: str(r.value_type) === 'float' ? 'float' : 'int',
      })
    }
    defs = { at: now(), ach, stats }
    return defs
  }

  // --- player stats ------------------------------------------------------------------------------------------
  async function playerStats(playerId: string): Promise<Map<string, Row>> {
    const m = new Map<string, Row>()
    for (let page = 1; page <= 10; page++) {
      const rows = await api.query('etc_player_stats', { filters: [eq('player_id', playerId)], page, size: 200 })
      for (const r of rows) m.set(str(r.stat_code), r)
      if (rows.length < 200) break
    }
    return m
  }

  function combine(agg: Aggregation, old: number | undefined, value: number): number {
    if (old === undefined) return value
    switch (agg) {
      case 'sum': return old + value
      case 'max': return Math.max(old, value)
      case 'min': return Math.min(old, value)
      case 'last': return value
    }
  }

  /** Applies one value to a stat (under the player lock). Returns the new value and whether it changed. */
  async function applyStat(playerId: string, def: StatDef, value: number): Promise<{ value: number; changed: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = (await api.query('etc_player_stats', { filters: [eq('player_id', playerId), eq('stat_code', def.code)], size: 1 }))[0]
      const old = row ? num(row.value) : undefined
      const next = combine(def.aggregation, old, value)
      if (row) {
        if (old === next) return { value: next, changed: false }
        await api.update('etc_player_stats', row.id as number, { value: next, updated_at: now() })
        return { value: next, changed: true }
      }
      const t = now()
      const made = await api.insert('etc_player_stats', { player_id: playerId, stat_code: def.code, value: next, updated_at: t })
      if (made !== 'conflict') {
        await api.update('etc_player_stats', made.row.id as number, { updated_at: t }) // insert drops the system column updated_at
        return { value: next, changed: true }
      }
    }
    throw new Error('stat row race')
  }

  // --- unlocks -----------------------------------------------------------------------------------------------
  const view = (a: AchDef, unlockedAt: number | null, synced: boolean, progress: AchievementView['progress']): AchievementView => ({
    code: a.code, title: a.title, description: a.description, secret: a.secret, image: a.image,
    unlocked: unlockedAt !== null, unlocked_at: unlockedAt, synced, progress,
  })

  async function unlock(playerId: string, a: AchDef, source: string): Promise<AchievementView | null> {
    const t = now()
    const made = await api.insert('etc_player_achievements', { player_id: playerId, achievement_code: a.code, unlocked_at: t, source })
    if (made === 'conflict') return null
    return view(a, t, false, null)
  }

  const reached = (def: StatDef | undefined, value: number, threshold: number): boolean => (def?.aggregation === 'min' ? value <= threshold : value >= threshold)

  /** Unlocks every stat rule satisfied by the player's current values (restricted to `only` stats when given). */
  async function evalStatRules(playerId: string, stats: Map<string, StatDef>, ach: AchDef[], values: Map<string, number>, only?: Set<string>): Promise<AchievementView[]> {
    const out: AchievementView[] = []
    for (const a of ach) {
      if (a.ruleType !== 'stat' || !a.ruleStat) continue
      if (only && !only.has(a.ruleStat)) continue
      const v = values.get(a.ruleStat)
      if (v === undefined || !reached(stats.get(a.ruleStat), v, a.threshold)) continue
      const u = await unlock(playerId, a, `stat:${a.ruleStat}`)
      if (u) out.push(u)
    }
    return out
  }

  async function claim(playerId: string, txId: string, op: string, params: string): Promise<{ fresh: true; id: number } | { fresh: false; row: Row }> {
    const made = await api.insert('etc_ledger', { tx_id: txId, player_id: playerId, op, game: '', coin_delta: 0, pack_delta: 0, params, result_json: null, created_at: now() })
    if (made !== 'conflict') return { fresh: true, id: made.row.id as number }
    const row = (await api.query('etc_ledger', { filters: [eq('tx_id', txId)], size: 1 }))[0]
    if (!row) throw new Error('ledger row vanished')
    return { fresh: false, row }
  }

  // --- built-in event stats ----------------------------------------------------------------------------------
  function eventUpdates(name: EventName, p: Record<string, unknown>, streak: number): Array<[string, number]> {
    switch (name) {
      case 'match_end': {
        const outcome = p.outcome
        if (outcome !== 'win' && outcome !== 'loss' && outcome !== 'draw') return []
        const ranked = p.queue === 'ranked'
        const out: Array<[string, number]> = [['matches_played', 1], [outcome === 'win' ? 'matches_won' : outcome === 'loss' ? 'matches_lost' : 'matches_drawn', 1]]
        if (ranked) { out.push(['ranked_matches_played', 1]); if (outcome === 'win') out.push(['ranked_matches_won', 1]) }
        const cur = outcome === 'win' ? streak + 1 : 0
        out.push(['win_streak_current', cur], ['win_streak_best', cur])
        if (typeof p.rating_after === 'number') out.push(['rating_peak', p.rating_after])
        return out
      }
      case 'pack_opened': {
        const out: Array<[string, number]> = [['packs_opened', 1]]
        if (typeof p.unique_cards === 'number') out.push(['cards_unique', p.unique_cards])
        return out
      }
      case 'purchase': return [['purchases', 1]]
      case 'reward': return [['rewards_claimed', 1]]
    }
  }

  return {
    async refresh() { defs = null; await loadDefs() },

    async stats(playerId) {
      const m = await playerStats(playerId)
      return Object.fromEntries([...m.entries()].map(([k, r]) => [k, num(r.value)]))
    },

    async list(playerId) {
      return locked([`ach:${playerId}`], async () => {
        const { ach, stats } = await loadDefs()
        const st = await playerStats(playerId)
        const values = new Map([...st.entries()].map(([k, r]) => [k, num(r.value)]))
        await evalStatRules(playerId, stats, ach, values) // catches up achievements added after the stat moved
        const rows = await api.query('etc_player_achievements', { filters: [eq('player_id', playerId)], size: 500 })
        const by = new Map(rows.map(r => [str(r.achievement_code), r]))
        const out: AchievementView[] = []
        const pending: string[] = []
        for (const a of ach) {
          const r = by.get(a.code)
          const progress = a.ruleType === 'stat' && a.ruleStat ? { stat: a.ruleStat, value: values.get(a.ruleStat) ?? 0, threshold: a.threshold } : null
          const unlocked = !!r
          const synced = !!r && r.synced_wavedash_at !== null && r.synced_wavedash_at !== undefined
          if (unlocked && !synced) pending.push(a.code)
          const v = view(a, unlocked ? num(r!.unlocked_at) : null, synced, progress)
          if (a.secret && !unlocked) { v.title = { fr: '???', en: '???' }; v.description = { fr: '', en: '' }; v.progress = null }
          out.push(v)
        }
        return { achievements: out, pending_sync: pending }
      })
    },

    async report(playerId, op, stat, value) {
      if (!OP_RE.test(op)) throw new StoreError('bad_argument', 'Invalid op')
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new StoreError('bad_argument', 'Invalid value')
      const { ach, stats } = await loadDefs()
      const def = stats.get(stat)
      if (!def) throw new StoreError('unknown_stat', 'Unknown stat')
      if (!def.clientWritable) throw new StoreError('stat_not_writable', 'This stat is maintained by the server')
      if (def.valueType === 'int' && !Number.isSafeInteger(value)) throw new StoreError('bad_argument', 'This stat takes integers')
      if (def.aggregation === 'sum' && value < 0) throw new StoreError('bad_argument', 'A sum stat only grows')
      if (def.maxDelta !== null && Math.abs(value) > def.maxDelta) throw new StoreError('bad_argument', 'Value above the limit of this stat')
      return locked([`ach:${playerId}`], async () => {
        const params = JSON.stringify({ stat, value })
        const c = await claim(playerId, `stat:${playerId}:${op}`, 'stat.report', params)
        if (!c.fresh) {
          if (c.row.params !== params) throw new StoreError('tx_conflict', 'Transaction id already used')
          const cur = (await api.query('etc_player_stats', { filters: [eq('player_id', playerId), eq('stat_code', stat)], size: 1 }))[0]
          return { stat, value: cur ? num(cur.value) : 0, applied: false, unlocked: [] }
        }
        const r = await applyStat(playerId, def, value)
        await api.update('etc_ledger', c.id, { result_json: JSON.stringify({ value: r.value }) })
        const unlocked = r.changed ? await evalStatRules(playerId, stats, ach, new Map([[stat, r.value]]), new Set([stat])) : []
        return { stat, value: r.value, applied: true, unlocked }
      })
    },

    async event(playerId, name, payload, key) {
      return locked([`ach:${playerId}`], async () => {
        if (key !== undefined) {
          const c = await claim(playerId, `ev:${name}:${playerId}:${key}`, 'ach.event', JSON.stringify({ name }))
          if (!c.fresh) return []
        }
        const { ach, stats } = await loadDefs()
        const changed = new Map<string, number>()
        const streakRow = (await api.query('etc_player_stats', { filters: [eq('player_id', playerId), eq('stat_code', 'win_streak_current')], size: 1 }))[0]
        for (const [code, value] of eventUpdates(name, payload, streakRow ? num(streakRow.value) : 0)) {
          const def = stats.get(code)
          if (!def) continue
          const r = await applyStat(playerId, def, value)
          if (r.changed) changed.set(code, r.value)
        }
        const out = await evalStatRules(playerId, stats, ach, changed, new Set(changed.keys()))
        for (const a of ach) {
          if (a.ruleType !== 'event' || a.ruleEvent !== name) continue
          let ok = false
          try { ok = matchesFilter(parseFilter(a.filter), payload) } catch { log('error', `[achievements] bad rule_filter on ${a.code}`) }
          if (!ok) continue
          const u = await unlock(playerId, a, `event:${name}`)
          if (u) out.push(u)
        }
        return out
      })
    },

    async ack(playerId, codes) {
      return locked([`ach:${playerId}`], async () => {
        const done: string[] = []
        for (const code of codes.slice(0, 200)) {
          const row = (await api.query('etc_player_achievements', { filters: [eq('player_id', playerId), eq('achievement_code', code)], size: 1 }))[0]
          if (!row) continue
          if (row.synced_wavedash_at === null || row.synced_wavedash_at === undefined) {
            await api.update('etc_player_achievements', row.id as number, { synced_wavedash_at: now() })
            done.push(code)
          }
        }
        return done
      })
    },
  }
}
