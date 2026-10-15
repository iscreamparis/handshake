// Publisher: pushes a prebuilt game archive to Wavedash with the real `wavedash` CLI and publishes a build.
// Owner games (kekkai, monsterracer) run the CLI with the service user's HOME, as before (a stored `wavedash auth
// login` still works for them). Creator games get a private per-run HOME + TMPDIR and must send their own token.
// Tokens arrive per request, reach one child process and are redacted from the run log. One run at a time
// (the VM is small). Commands are spawned with argument arrays, never through a shell.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { achievementArgs, parseCreatedId, parseExisting, planCommands, portalJson, validateCatalog } from './catalog.ts'
import type { Catalog } from './catalog.ts'
import { isLegacyGame } from '../store/legacy.ts'
import type { TableApi } from '../store/tables.ts'

export interface GameConfig { name: string; game_id: string }
export interface PublisherConfig {
  dataDir: string
  /** HOME of the service user (the CLI's own stored login): used by owner-game runs and the status probes only. */
  home: string
  wavedashBin: string
  /** itch.io's `butler` (platform "itch"); default `butler`. */
  butlerBin?: string
  /** Optional static table (compat): the normal path is a request that carries game + game_id. */
  games?: Record<string, GameConfig>
  maxArtifactBytes: number
  keepArtifacts: number
  runTimeoutMs: number
  /** Optional: mirror every OWNER-game run into the tenant table etc_deploy_runs (ETCITO_URL + ETCITO_API_KEY). */
  recorder?: TableApi
  maxQueuedRuns?: number
}
export type RunStatus = 'queued' | 'running' | 'ok' | 'failed'
export type Platform = 'wavedash' | 'itch'
export interface Run {
  id: string
  game: string
  platform?: Platform
  action: 'push' | 'publish' | 'catalog'
  artifact: string | null
  build_id: string | null
  request_id: number | null
  /** Opaque id of the backoffice publisher row that asked for this run (echoed back, never interpreted). */
  publisher_id: number | string | null
  message: string
  status: RunStatus
  exit_code: number | null
  started_at: number
  ended_at: number | null
  log: string
}
export interface RunRequest {
  /** Slug, also the artifacts folder. */
  game: string
  /** Wavedash game id; takes precedence over cfg.games[game]. For platform "itch": the target `user/game:channel`. */
  game_id?: string
  /** Default "wavedash". "itch" only supports action "push" (butler has no separate publish). */
  platform?: Platform
  /** Display label (<= 80). */
  name?: string
  publisher_id?: number | string
  action: 'push' | 'publish'
  artifact?: string
  build_id?: string
  message?: string
  title?: string
  summary?: string
  /** id of the etc_deploy_requests row that asked for this run (set by the backoffice workflow). */
  request_id?: number | string
}
export interface CatalogRequest {
  game: string
  game_id?: string
  name?: string
  publisher_id?: number | string
  /** achievements + stats as the backoffice built them (see catalog.ts). */
  catalog: unknown
  /** Default TRUE: nothing is sent, the plan is returned. Only an explicit false executes (and then needs the token). */
  dry_run?: boolean
}
export interface CatalogDryRun {
  dry_run: true
  game: string
  game_id: string
  counts: { achievements: number; stats: number }
  /** The JSON of Developer Portal > Achievements > Import JSON. */
  portal_json: { achievements: unknown[]; stats: unknown[] }
  /** The wavedash CLI commands a real run would execute (the CLI has no import command). */
  commands: string[][]
}
export class PublisherError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'PublisherError' }
}

const GAME_RE = /^[a-z0-9_-]{1,32}$/
const GAME_ID_RE = /^[A-Za-z0-9]{8,64}$/
const ARTIFACT_RE = /^[0-9]{13}-[0-9a-f]{8}\.tar\.gz$/
/** itch.io butler target: user/game:channel. */
export const ITCH_TARGET_RE = /^[A-Za-z0-9_-]{1,50}\/[A-Za-z0-9_-]{1,80}:[A-Za-z0-9_.-]{1,50}$/
const BUILD_ID_RE =/^[A-Za-z0-9_-]{6,64}$/
const LOG_MAX = 64 * 1024

/** The CLI prints the build ID and a playtest URL; the exact text is not documented, so accept the usual shapes. */
export function parseBuildId(output: string): string | null {
  const labelled = /build[\s_-]*id\W{0,4}\s*([A-Za-z0-9_-]{6,64})/i.exec(output)
  if (labelled) return labelled[1]!
  const url = /\/builds?\/([A-Za-z0-9_-]{6,64})/i.exec(output)
  return url ? url[1]! : null
}

function clip(s: string): string { return s.length > LOG_MAX ? '…' + s.slice(-LOG_MAX) : s }
function clean(s: string | undefined, max: number): string { return (s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) }

export function createPublisher(cfg: PublisherConfig) {
  const dirs = { artifacts: join(cfg.dataDir, 'artifacts'), runs: join(cfg.dataDir, 'runs'), work: join(cfg.dataDir, 'work') }
  let chain: Promise<unknown> = Promise.resolve()
  const maxQueuedRuns = Number.isSafeInteger(cfg.maxQueuedRuns) && (cfg.maxQueuedRuns ?? 0) > 0 ? Math.min(cfg.maxQueuedRuns!, 100) : 8
  const pending = () => [...live.values()].filter(r => r.status === 'queued' || r.status === 'running').length
  const queueCheck = () => { if (pending() >= maxQueuedRuns) throw new PublisherError(429, 'publisher queue full') }
  const live = new Map<string, Run>()
  const rowIds = new Map<string, number>()
  let recordChain: Promise<unknown> = Promise.resolve()

  /**
   * Mirror an OWNER run into the tenant (etc_deploy_runs of the recorder key's mission), as before. Creator runs are
   * never mirrored: that key reads the owner's mission. Serialised, never throws, never blocks a run.
   */
  function record(run: Run): void {
    const recorder = cfg.recorder
    if (!recorder || !isLegacyGame(run.game)) return
    const done = run.status === 'ok' || run.status === 'failed'
    const patch = { status: run.status, exit_code: run.exit_code, build_id: run.build_id, ended_at: run.ended_at, log: done ? run.log.slice(-8000) : null }
    recordChain = recordChain.then(async () => {
      try {
        const id = rowIds.get(run.id)
        if (id === undefined) {
          const r = await recorder.insert('etc_deploy_runs', {
            run_id: run.id, request_id: run.request_id, game: run.game, action: run.action,
            artifact: run.artifact, message: run.message, started_at: run.started_at, ...patch,
          })
          if (r !== 'conflict') rowIds.set(run.id, r.row.id as number)
        } else {
          await recorder.update('etc_deploy_runs', id, patch)
        }
      } catch (e) {
        console.error('[publisher] tenant record failed:', (e as Error).message)
      }
    })
  }

  function checkSlug(game: string): void {
    if (typeof game !== 'string' || !GAME_RE.test(game)) throw new PublisherError(400, 'invalid game slug')
  }
  /** game_id from the request wins; otherwise the optional static table; otherwise 400. */
  function resolveGame(req: { game: string; game_id?: string; name?: string; platform?: Platform }): GameConfig {
    checkSlug(req.game)
    const label = clean(req.name, 80)
    if (req.platform === 'itch') {
      const target = req.game_id ?? ''
      if (!ITCH_TARGET_RE.test(target) || target === 'a-renseigner' || /a-renseigner/.test(target)) {
        throw new PublisherError(400, 'itch: external_id must be user/game:channel (e.g. monuser/monjeu:html5)')
      }
      return { name: label || req.game, game_id: target }
    }
    if (req.game_id !== undefined && req.game_id !== '') {
      if (!GAME_ID_RE.test(req.game_id)) throw new PublisherError(400, 'invalid game_id')
      return { name: label || cfg.games?.[req.game]?.name || req.game, game_id: req.game_id }
    }
    // Static game ids are an owner migration aid only. Creator runs always carry their own target.
    const g = (isLegacyGame(req.game) || req.game === 'kart') && Object.hasOwn(cfg.games ?? {}, req.game) ? cfg.games![req.game] : undefined
    if (!g) throw new PublisherError(400, 'unknown game')
    return { name: label || g.name, game_id: g.game_id }
  }
  const persist = (run: Run) => writeFile(join(dirs.runs, `${run.id}.json`), JSON.stringify(run)).catch(() => undefined)

  /** The Wavedash key arrives per request (the tenant's Réglages hold it): it reaches ONE child as WAVEDASH_TOKEN and is never stored or logged. */
  function tokenEnv(token?: string): Record<string, string> {
    if (token === undefined || token === '') return {}
    if (!/^[!-~]{8,512}$/.test(token)) throw new PublisherError(400, 'invalid Wavedash token')
    return { WAVEDASH_TOKEN: token }
  }

  /** The itch key arrives per request like the Wavedash one: ONE child gets it as BUTLER_API_KEY, never stored or logged. */
  function itchEnv(key?: string): Record<string, string> {
    if (key === undefined || key === '') return {}
    if (!/^[!-~]{8,512}$/.test(key)) throw new PublisherError(400, 'invalid itch API key')
    return { BUTLER_API_KEY: key }
  }

  function scrub(value: string, env: Record<string, string> = {}): string {
    let clean = value
    for (const secret of Object.values(env)) if (secret.length >= 8) clean = clean.replaceAll(secret, '[REDACTED]')
    return clean.replace(/(x-wavedash-token|x-itch-token|authorization|wavedash_token|butler_api_key|api[_-]?key|secret|token)([\s:=]+)([^\s,;]+)/gi, '$1$2[REDACTED]')
      .replace(/\b(?:gsk_|sk_(?:live|test)_|whsec_)[A-Za-z0-9_-]+/g, '[REDACTED]')
  }
  /**
   * Owner games (kekkai, monsterracer) and the read-only status probes keep today's environment: the service user's
   * HOME (cfg.home), where `wavedash auth login` may have stored the owner's credentials. Every other (creator) run
   * gets a private HOME + TMPDIR under its work dir (removed with it) and only its own request token.
   */
  const sharedHome = (run: Run): boolean => run.game === '' || isLegacyGame(run.game)
  async function exec(args: string[], cwd: string, run: Run, extraEnv: Record<string, string> = {}, bin: string = cfg.wavedashBin): Promise<{ code: number | null; out: string }> {
    let env: Record<string, string>
    if (sharedHome(run)) {
      env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cfg.home, CI: '1', ...extraEnv }
    } else {
      // run.id is a server-made UUID: the per-run dirs never come from the request.
      const home = join(dirs.work, run.id, 'home'), tmp = join(dirs.work, run.id, 'tmp')
      await mkdir(home, { recursive: true, mode: 0o700 })
      await mkdir(tmp, { recursive: true, mode: 0o700 })
      env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(tmp, 'cache'), CI: '1', ...extraEnv }
    }
    return new Promise(resolve => {
      let out = ''
      let partial = ''
      // The log stays live while the CLI runs (the backoffice polls it), redacted line by line.
      const flush = (all: boolean) => {
        const cut = all ? partial.length : Math.max(partial.lastIndexOf('\n') + 1, partial.length > 8192 ? partial.length : 0)
        if (cut === 0) return
        run.log = clip(run.log + scrub(partial.slice(0, cut), extraEnv))
        partial = partial.slice(cut)
      }
      const child = spawn(bin, args, { cwd, shell: false, env })
      const timer = setTimeout(() => { out += '\n[publisher] timeout, killing the CLI\n'; child.kill('SIGKILL') }, cfg.runTimeoutMs)
      const feed = (b: Buffer) => { const s = b.toString('utf8'); out += s; partial += s; flush(false) }
      child.stdout.on('data', feed)
      child.stderr.on('data', feed)
      let settled = false
      const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); flush(true); resolve({ code, out }) }
      child.on('error', e => { const m = `\n[publisher] cannot run the CLI: ${e.message}\n`; out += m; partial += m; finish(null) })
      child.on('close', finish)
    })
  }
  function untar(archive: string, dest: string, run: Run): Promise<number | null> {
    return new Promise(resolve => {
      const child = spawn('tar', ['-xzf', archive, '-C', dest, '--no-same-owner'], { shell: false })
      child.stderr.on('data', (b: Buffer) => { run.log = clip(scrub(run.log + b.toString('utf8'))) })
      child.on('error', () => resolve(null))
      child.on('close', code => resolve(code))
    })
  }

  async function execute(run: Run, req: RunRequest, game: GameConfig, env: Record<string, string>): Promise<void> {
    const work = join(dirs.work, run.id)
    await mkdir(join(work, 'dist'), { recursive: true })
    try {
      if (run.platform === 'itch') {
        const code = await untar(join(dirs.artifacts, run.game, run.artifact!), join(work, 'dist'), run)
        if (code !== 0) { run.exit_code = code; run.status = 'failed'; return }
        const r = await exec(['push', '--userversion', run.message, join(work, 'dist'), game.game_id], work, run, env, cfg.butlerBin ?? 'butler')
        run.exit_code = r.code
        run.status = r.code === 0 ? 'ok' : 'failed'
        return
      }
      await writeFile(join(work, 'wavedash.toml'), `game_id = "${game.game_id}"\nupload_dir = "./dist"\n`)
      let result: { code: number | null; out: string }
      if (run.action === 'push') {
        const code = await untar(join(dirs.artifacts, run.game, run.artifact!), join(work, 'dist'), run)
        if (code !== 0) { run.exit_code = code; run.status = 'failed'; return }
        result = await exec(['build', 'push', '-c', join(work, 'wavedash.toml'), '-m', run.message], work, run, env)
        run.build_id = parseBuildId(result.out)
        if (result.code === 0 && !run.build_id) run.log += '\n[publisher] pushed, but the build id could not be read from the output: use the id shown in the Wavedash developer portal for Publish.\n'
      } else {
        const args = ['publish', run.build_id!, '-c', join(work, 'wavedash.toml'), '--yes']
        const title = clean(req.title, 120), summary = clean(req.summary, 500)
        if (title) args.push('--title', title)
        if (summary) args.push('--summary', summary)
        result = await exec(args, work, run, env)
      }
      run.exit_code = result.code
      run.status = result.code === 0 ? 'ok' : 'failed'
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Runs the catalogue through the CLI: list what exists, create stats, create or update achievements. Warnings never fail the run, a failed command does. */
  async function executeCatalog(run: Run, catalog: Catalog, game: GameConfig, env: Record<string, string>): Promise<void> {
    const work = join(dirs.work, run.id)
    await mkdir(work, { recursive: true })
    const say = (m: string) => { run.log = clip(run.log + `\n[catalog] ${m}\n`) }
    try {
      await writeFile(join(work, 'wavedash.toml'), `game_id = "${game.game_id}"\n`)
      const cfgArgs = ['-c', join(work, 'wavedash.toml')]
      const cli = async (args: string[]) => exec([...args, ...cfgArgs], work, run, env)
      const listed = await cli(['achievement', 'list', '--json'])
      if (listed.code !== 0) { run.exit_code = listed.code; run.status = 'failed'; say('cannot list the existing achievements, nothing was changed'); return }
      const existing = new Map(parseExisting(listed.out).map(a => [a.identifier, a.id]))
      const statIds = new Map<string, string>()
      let failed = 0
      for (const s of catalog.stats) {
        const r = await cli(['stat', 'create', '--identifier', s.identifier, '--name', s.display_name])
        if (r.code === 0) {
          const id = parseCreatedId(r.out)
          if (id) statIds.set(s.identifier, id); else say(`stat ${s.identifier} created, its id could not be read from the output`)
        } else if (/exist|already|duplicate|taken|unique/i.test(r.out)) {
          say(`stat ${s.identifier} already exists (not updated: the CLI needs its numeric id)`)
        } else { failed++; say(`stat ${s.identifier} failed`) }
      }
      for (const a of catalog.achievements) {
        const statId = a.stat_requirement ? statIds.get(a.stat_requirement.stat) ?? null : null
        if (a.stat_requirement && !statId) say(`achievement ${a.identifier}: id of stat ${a.stat_requirement.stat} unknown, sent WITHOUT its stat trigger (link it in the portal or use the import JSON)`)
        const r = await cli(achievementArgs(a, existing.get(a.identifier) ?? null, statId))
        if (r.code !== 0) { failed++; say(`achievement ${a.identifier} failed`) }
      }
      run.exit_code = failed === 0 ? 0 : 1
      run.status = failed === 0 ? 'ok' : 'failed'
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Dry run by default (returns the plan, needs no token); only `dry_run: false` with a Wavedash token executes. */
  async function startCatalog(req: CatalogRequest, token?: string): Promise<CatalogDryRun | Run> {
    const game = resolveGame({ game: req.game, game_id: req.game_id, name: req.name, platform: 'wavedash' })
    let catalog: Catalog
    try { catalog = validateCatalog(req.catalog) } catch (e) { throw new PublisherError(400, (e as Error).message) }
    if (req.dry_run !== false) {
      return {
        dry_run: true, game: req.game, game_id: game.game_id,
        counts: { achievements: catalog.achievements.length, stats: catalog.stats.length },
        portal_json: portalJson(catalog), commands: planCommands(catalog).map(a => ['wavedash', ...a]),
      }
    }
    const env = tokenEnv(token)
    if (!env.WAVEDASH_TOKEN) throw new PublisherError(409, 'Wavedash API key missing (Réglage wavedash_api_token)')
    if ([...live.values()].some(r => r.game === req.game && (r.status === 'queued' || r.status === 'running'))) throw new PublisherError(409, 'a run is already in progress for this game')
    queueCheck()
    const pid = req.publisher_id
    const run: Run = {
      id: randomUUID(), game: req.game, platform: 'wavedash', action: 'catalog', artifact: null, build_id: null, request_id: null,
      publisher_id: typeof pid === 'number' && Number.isSafeInteger(pid) ? pid : typeof pid === 'string' && pid !== '' ? clean(pid, 64) : null,
      message: `catalogue ${catalog.achievements.length} achievements, ${catalog.stats.length} stats`,
      status: 'queued', exit_code: null, started_at: Date.now(), ended_at: null, log: '',
    }
    live.set(run.id, run)
    await mkdir(dirs.runs, { recursive: true })
    await persist(run)
    record(run)
    chain = chain.then(async () => {
      run.status = 'running'
      await persist(run)
      record(run)
      try { await executeCatalog(run, catalog, game, env) } catch (e) { run.status = 'failed'; run.log = clip(scrub(run.log + `\n[publisher] ${(e as Error).message}\n`, env)) }
      run.ended_at = Date.now()
      await persist(run)
      record(run)
    })
    return run
  }

  async function prune(game: string): Promise<void> {
    const names = (await listArtifacts(game)).map(a => a.name)
    for (const old of names.slice(cfg.keepArtifacts)) await rm(join(dirs.artifacts, game, old), { force: true })
  }

  async function listArtifacts(game: string): Promise<{ name: string; bytes: number }[]> {
    checkSlug(game)
    const dir = join(dirs.artifacts, game)
    const names = (await readdir(dir).catch(() => [] as string[])).filter(n => ARTIFACT_RE.test(n)).sort().reverse()
    return Promise.all(names.map(async name => ({ name, bytes: (await stat(join(dir, name))).size })))
  }

  async function saveArtifact(game: string, body: Readable): Promise<{ artifact: string; bytes: number; sha256: string }> {
    checkSlug(game)
    const dir = join(dirs.artifacts, game)
    await mkdir(dir, { recursive: true })
    const artifact = `${Date.now()}-${randomUUID().slice(0, 8)}.tar.gz`
    const tmp = join(dir, `${artifact}.part`)
    const hash = createHash('sha256')
    let bytes = 0
    const out = createWriteStream(tmp)
    try {
      await new Promise<void>((resolve, reject) => {
        // Over the limit: stop storing but keep draining (so the client gets a clean 413, not a reset);
        // a sender that keeps going far past the limit is cut off.
        let tooBig = false
        body.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (tooBig || bytes > cfg.maxArtifactBytes) {
            tooBig = true
            if (bytes > cfg.maxArtifactBytes * 4) body.destroy()
            return
          }
          hash.update(chunk)
          if (!out.write(chunk)) { body.pause(); out.once('drain', () => body.resume()) }
        })
        body.on('end', () => (tooBig ? reject(new PublisherError(413, 'artifact too large')) : out.end(() => resolve())))
        body.on('close', () => { if (tooBig) reject(new PublisherError(413, 'artifact too large')) })
        body.on('error', reject)
        out.on('error', reject)
      })
      if (bytes === 0) throw new PublisherError(400, 'empty artifact')
      await rename(tmp, join(dir, artifact))
    } catch (e) {
      out.destroy()
      await rm(tmp, { force: true })
      throw e
    }
    await prune(game)
    return { artifact, bytes, sha256: hash.digest('hex') }
  }

  async function startRun(req: RunRequest, token?: string, itchKey?: string): Promise<Run> {
    const platform: Platform = req.platform === 'itch' ? 'itch' : 'wavedash'
    if (req.platform !== undefined && req.platform !== 'itch' && req.platform !== 'wavedash') throw new PublisherError(400, 'unknown platform')
    const env = platform === 'itch' ? itchEnv(itchKey) : tokenEnv(token)
    if (platform === 'itch' && !env.BUTLER_API_KEY) throw new PublisherError(409, 'itch: API key missing (Réglage itch_api_key)')
    // A creator run never falls back to the CLI login stored in the shared HOME: it must bring its own key.
    if (platform === 'wavedash' && !env.WAVEDASH_TOKEN && !isLegacyGame(req.game)) throw new PublisherError(409, 'Wavedash API key missing (Réglage wavedash_api_token)')
    const game = resolveGame({ ...req, platform })
    if (req.action !== 'push' && req.action !== 'publish') throw new PublisherError(400, 'action must be push or publish')
    if (platform === 'itch' && req.action !== 'push') throw new PublisherError(400, 'itch has no separate publish: use push')
    let artifact: string | null = null
    let buildId: string | null = null
    if (req.action === 'push') {
      const list = await listArtifacts(req.game)
      artifact = req.artifact ?? list[0]?.name ?? null
      if (!artifact || !ARTIFACT_RE.test(artifact) || !list.some(a => a.name === artifact)) throw new PublisherError(404, 'no such artifact: upload a build first')
    } else {
      buildId = req.build_id ?? null
      if (!buildId || !BUILD_ID_RE.test(buildId)) throw new PublisherError(400, 'a valid build_id is required to publish')
    }
    // Idempotent per backoffice request: a workflow retry (or a double insert) must not start a second deploy.
    const pid = req.publisher_id
    const publisherId = typeof pid === 'number' && Number.isSafeInteger(pid) ? pid : typeof pid === 'string' && pid !== '' ? clean(pid, 64) : null
    const rid = Number(req.request_id)
    const requestId = Number.isSafeInteger(rid) && rid > 0 ? rid : null
    if (requestId !== null) {
      const prior = [...live.values()].find(r => r.request_id === requestId)
        ?? (await listRuns(1000)).find(r => r.request_id === requestId)
      if (prior) return (await getRun(prior.id)) ?? (prior as Run)
    }
    if ([...live.values()].some(r => r.game === req.game && (r.status === 'queued' || r.status === 'running'))) throw new PublisherError(409, 'a run is already in progress for this game')
    queueCheck()
    const run: Run = {
      id: randomUUID(), game: req.game, platform, action: req.action, artifact, build_id: buildId, request_id: requestId,
      publisher_id: publisherId,
      message: scrub(clean(req.message, 200), env) || `${game.name} ${new Date().toISOString().slice(0, 16)}Z`,
      status: 'queued', exit_code: null, started_at: Date.now(), ended_at: null, log: '',
    }
    live.set(run.id, run)
    await mkdir(dirs.runs, { recursive: true })
    await persist(run)
    record(run)
    chain = chain.then(async () => {
      run.status = 'running'
      await persist(run)
      record(run)
      try { await execute(run, req, game, env) } catch (e) { run.status = 'failed'; run.log = clip(scrub(run.log + `\n[publisher] ${(e as Error).message}\n`, env)) }
      run.ended_at = Date.now()
      await persist(run)
      record(run)
    })
    return run
  }

  async function getRun(id: string): Promise<Run | null> {
    const l = live.get(id)
    if (l) return l
    if (!/^[0-9a-f-]{36}$/.test(id)) return null
    try { return JSON.parse(await readFile(join(dirs.runs, `${id}.json`), 'utf8')) as Run } catch { return null }
  }
  async function listRuns(limit = 30): Promise<Omit<Run, 'log'>[]> {
    const names = (await readdir(dirs.runs).catch(() => [] as string[])).filter(n => n.endsWith('.json'))
    const runs: Run[] = []
    for (const n of names) {
      const id = n.slice(0, -5)
      const r = await getRun(id)
      if (r) runs.push(r)
    }
    return runs.sort((a, b) => b.started_at - a.started_at).slice(0, limit).map(({ log: _log, ...r }) => r)
  }

  /** Read-only: is the CLI logged in for this HOME (or with this token)? Unchanged probe: the service user's HOME. */
  async function authStatus(token?: string): Promise<{ authenticated: boolean; detail: string }> {
    const probe: Run = { id: 'auth', game: '', action: 'push', artifact: null, build_id: null, request_id: null, publisher_id: null, message: '', status: 'running', exit_code: null, started_at: Date.now(), ended_at: null, log: '' }
    const env = tokenEnv(token)
    const r = await exec(['auth', 'status'], cfg.dataDir, probe, env)
    const text = r.out.replace(/\u001b\[[0-9;]*m/g, '').trim()
    return { authenticated: r.code === 0 && /authenticated/i.test(text) && !/not authenticated/i.test(text), detail: scrub(text, env).slice(0, 300) }
  }

  /** `butler status target` (read-only): needs the itch key. */
  async function itchStatus(target: string, key?: string): Promise<{ ok: boolean; detail: string }> {
    if (!ITCH_TARGET_RE.test(target) || /a-renseigner/.test(target)) throw new PublisherError(400, 'itch: external_id must be user/game:channel')
    const env = itchEnv(key)
    if (!env.BUTLER_API_KEY) throw new PublisherError(409, 'itch: API key missing (Réglage itch_api_key)')
    const probe: Run = { id: 'itch', game: '', action: 'push', artifact: null, build_id: null, request_id: null, publisher_id: null, message: '', status: 'running', exit_code: null, started_at: Date.now(), ended_at: null, log: '' }
    const r = await exec(['status', target], cfg.dataDir, probe, env, cfg.butlerBin ?? 'butler')
    return { ok: r.code === 0, detail: scrub(r.out.replace(/\u001b\[[0-9;]*m/g, '').trim(), env).slice(0, 600) }
  }

  return {
    itchStatus,
    games: () => Object.entries(cfg.games ?? {}).map(([id, g]) => ({ id, name: g.name })),
    listArtifacts, saveArtifact, startRun, startCatalog, getRun, listRuns, authStatus,
    /** Resolves when every queued run has finished (tests, graceful shutdown). */
    idle: () => chain.then(() => recordChain).then(() => undefined),
  }
}
export type Publisher = ReturnType<typeof createPublisher>
