// The achievements + stats catalogue of a game, as Wavedash wants it.
//
// Two shapes come out of one validated input:
//   * `portalJson`: the exact JSON of the Developer Portal > Achievements > Import JSON (`achievements` + `stats`,
//     docs.wavedash.com/sdk/achievements). Items are matched by `identifier`; an import overwrites display_name,
//     description, secret and stat_requirement and keeps icons.
//   * `planCommands`: the `wavedash stat|achievement` CLI commands (docs.wavedash.com/cli/commands). The CLI has NO import
//     command, only create/update/delete/list, and it takes numeric ids for updates and for the stat link.
// Wavedash has no translations for achievements: one display_name / description per item (the caller picks the language).

export interface CatalogStat { identifier: string; display_name: string }
export interface CatalogAchievement {
  identifier: string
  display_name: string
  description: string
  secret: boolean
  stat_requirement: { stat: string; threshold: number } | null
}
export interface Catalog { achievements: CatalogAchievement[]; stats: CatalogStat[] }

const IDENT_RE = /^[A-Za-z0-9_]{1,64}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates the catalogue sent by the backoffice; throws an Error with a message fit for the operator. */
export function validateCatalog(input: unknown): Catalog {
  if (!isObj(input)) throw new Error('catalog must be an object')
  const statsIn = input.stats ?? []
  const achIn = input.achievements ?? []
  if (!Array.isArray(statsIn) || !Array.isArray(achIn)) throw new Error('stats and achievements must be arrays')
  if (statsIn.length > 200 || achIn.length > 200) throw new Error('at most 200 stats and 200 achievements')
  const stats: CatalogStat[] = []
  const seenStats = new Set<string>()
  for (const s of statsIn) {
    if (!isObj(s) || typeof s.identifier !== 'string' || !IDENT_RE.test(s.identifier)) throw new Error('stat.identifier must be 1..64 chars of A-Za-z0-9_')
    if (seenStats.has(s.identifier)) throw new Error(`duplicate stat ${s.identifier}`)
    if (typeof s.display_name !== 'string' || s.display_name.trim() === '' || s.display_name.length > 120) throw new Error(`stat ${s.identifier}: display_name must be 1..120 chars`)
    seenStats.add(s.identifier)
    stats.push({ identifier: s.identifier, display_name: s.display_name.trim() })
  }
  const achievements: CatalogAchievement[] = []
  const seen = new Set<string>()
  for (const a of achIn) {
    if (!isObj(a) || typeof a.identifier !== 'string' || !IDENT_RE.test(a.identifier)) throw new Error('achievement.identifier must be 1..64 chars of A-Za-z0-9_')
    if (seen.has(a.identifier)) throw new Error(`duplicate achievement ${a.identifier}`)
    seen.add(a.identifier)
    if (typeof a.display_name !== 'string' || a.display_name.trim() === '' || a.display_name.length > 120) throw new Error(`achievement ${a.identifier}: display_name must be 1..120 chars`)
    if (typeof a.description !== 'string' || a.description.length > 500) throw new Error(`achievement ${a.identifier}: description must be a string of at most 500 chars`)
    let req: CatalogAchievement['stat_requirement'] = null
    if (a.stat_requirement !== null && a.stat_requirement !== undefined) {
      const r = a.stat_requirement
      if (!isObj(r) || typeof r.stat !== 'string' || typeof r.threshold !== 'number' || !Number.isFinite(r.threshold)) throw new Error(`achievement ${a.identifier}: bad stat_requirement`)
      if (!seenStats.has(r.stat)) throw new Error(`achievement ${a.identifier}: stat ${r.stat} is not in the catalogue`)
      req = { stat: r.stat, threshold: r.threshold }
    }
    achievements.push({ identifier: a.identifier, display_name: a.display_name.trim(), description: a.description.trim(), secret: a.secret === true, stat_requirement: req })
  }
  return { achievements, stats }
}

/** The Developer Portal import JSON (key order and fields as in the Wavedash documentation). */
export function portalJson(c: Catalog): { achievements: unknown[]; stats: unknown[] } {
  return {
    achievements: c.achievements.map(a => ({
      identifier: a.identifier, display_name: a.display_name, description: a.description, secret: a.secret,
      stat_requirement: a.stat_requirement ? { stat: a.stat_requirement.stat, threshold: a.stat_requirement.threshold } : null,
    })),
    stats: c.stats.map(s => ({ identifier: s.identifier, display_name: s.display_name })),
  }
}

export interface ExistingAchievement { id: string; identifier: string }

/** `achievement list --json` -> the ids of the achievements already on Wavedash (tolerant of the exact field names). */
export function parseExisting(output: string): ExistingAchievement[] {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    const rows = JSON.parse(output.slice(start, end + 1)) as unknown
    if (!Array.isArray(rows)) return []
    const out: ExistingAchievement[] = []
    for (const r of rows) {
      if (!isObj(r)) continue
      const identifier = r.identifier ?? r.key ?? r.name
      const id = r.id ?? r._id
      if (typeof identifier === 'string' && (typeof id === 'string' || typeof id === 'number')) out.push({ id: String(id), identifier })
    }
    return out
  } catch { return [] }
}

/** The id printed by `stat create` (format undocumented): `id: abc`, `id=abc`, `ID abc` or a JSON {"id": ...}. */
export function parseCreatedId(output: string): string | null {
  const m = /["']?\bid["']?\s*[:=]?\s*["']?([A-Za-z0-9_-]{4,64})["']?/i.exec(output)
  return m ? m[1]! : null
}

/** Arguments of `wavedash achievement create|update`. `statId` = the numeric/opaque Wavedash id of the triggering stat, when known. */
export function achievementArgs(a: CatalogAchievement, existingId: string | null, statId: string | null): string[] {
  const args = existingId
    ? ['achievement', 'update', '--id', existingId, '--title', a.display_name, '--description', a.description, '--secret', a.secret ? 'true' : 'false']
    : ['achievement', 'create', '--identifier', a.identifier, '--title', a.display_name, '--description', a.description, ...(a.secret ? ['--secret'] : [])]
  if (a.stat_requirement && statId) args.push('--triggered-by-stat-id', statId, '--threshold', String(a.stat_requirement.threshold))
  return args
}

/** What a real run would execute, for the dry-run display (ids that are only known at run time are shown as placeholders). */
export function planCommands(c: Catalog): string[][] {
  const out: string[][] = [['achievement', 'list', '--json']]
  for (const s of c.stats) out.push(['stat', 'create', '--identifier', s.identifier, '--name', s.display_name])
  for (const a of c.achievements) out.push(achievementArgs(a, null, a.stat_requirement ? `<id of stat ${a.stat_requirement.stat}>` : null))
  return out
}
