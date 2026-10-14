// Publisher: pushes a prebuilt game archive to Wavedash with the real `wavedash` CLI and publishes a build.
// Credentials are the CLI's own (written once by `wavedash auth login` in the service user's HOME): this module
// never stores, reads or refreshes them, it only runs the CLI with that HOME and reports `auth status`.
// One run at a time (the VM is small). Commands are spawned with argument arrays, never through a shell.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { TableApi } from '../store/tables.ts'

export interface GameConfig { name: string; game_id: string }
export interface PublisherConfig {
  dataDir: string
  /** HOME of the service user: where the wavedash CLI keeps its own credentials. */
  home: string
  wavedashBin: string
  games: Record<string, GameConfig>
  maxArtifactBytes: number
  keepArtifacts: number
  runTimeoutMs: number
  /** Optional: mirror every run into the tenant table etc_deploy_runs (the backoffice reads it). */
  recorder?: TableApi
}
export type RunStatus = 'queued' | 'running' | 'ok' | 'failed'
export interface Run {
  id: string
  game: string
  action: 'push' | 'publish'
  artifact: string | null
  build_id: string | null
  message: string
  status: RunStatus
  exit_code: number | null
  started_at: number
  ended_at: number | null
  log: string
}
export interface RunRequest {
  game: string
  action: 'push' | 'publish'
  artifact?: string
  build_id?: string
  message?: string
  title?: string
  summary?: string
  /** id of the etc_deploy_requests row that asked for this run (set by the backoffice workflow). */
  request_id?: number | string
}
export class PublisherError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'PublisherError' }
}

const GAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const ARTIFACT_RE = /^[0-9]{13}-[0-9a-f]{8}\.tar\.gz$/
const BUILD_ID_RE = /^[A-Za-z0-9_-]{6,64}$/
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
  const live = new Map<string, Run>()
  const rowIds = new Map<string, number>()
  const requestIds = new Map<string, number | null>()
  let recordChain: Promise<unknown> = Promise.resolve()

  /** Mirror a run into the tenant. Serialised, never throws, never blocks a run: the tenant being down is not a deploy failure. */
  function record(run: Run): void {
    const recorder = cfg.recorder
    if (!recorder) return
    const done = run.status === 'ok' || run.status === 'failed'
    const patch = { status: run.status, exit_code: run.exit_code, build_id: run.build_id, ended_at: run.ended_at, log: done ? run.log.slice(-8000) : null }
    recordChain = recordChain.then(async () => {
      try {
        const id = rowIds.get(run.id)
        if (id === undefined) {
          const r = await recorder.insert('etc_deploy_runs', {
            run_id: run.id, request_id: requestIds.get(run.id) ?? null, game: run.game, action: run.action,
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

  function gameOf(game: string): GameConfig {
    const g = GAME_RE.test(game) ? cfg.games[game] : undefined
    if (!g) throw new PublisherError(404, 'unknown game')
    return g
  }
  const persist = (run: Run) => writeFile(join(dirs.runs, `${run.id}.json`), JSON.stringify(run)).catch(() => undefined)

  function exec(args: string[], cwd: string, run: Run, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
    return new Promise(resolve => {
      let out = ''
      const child = spawn(cfg.wavedashBin, args, {
        cwd, shell: false,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cfg.home, CI: '1', ...extraEnv },
      })
      const timer = setTimeout(() => { out += '\n[publisher] timeout, killing the CLI\n'; child.kill('SIGKILL') }, cfg.runTimeoutMs)
      const feed = (b: Buffer) => { out += b.toString('utf8'); run.log = clip(run.log + b.toString('utf8')) }
      child.stdout.on('data', feed)
      child.stderr.on('data', feed)
      child.on('error', e => { clearTimeout(timer); out += `\n[publisher] cannot run the CLI: ${e.message}\n`; run.log = clip(run.log + `\n[publisher] cannot run the CLI: ${e.message}\n`); resolve({ code: null, out }) })
      child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
    })
  }
  function untar(archive: string, dest: string, run: Run): Promise<number | null> {
    return new Promise(resolve => {
      const child = spawn('tar', ['-xzf', archive, '-C', dest, '--no-same-owner'], { shell: false })
      child.stderr.on('data', (b: Buffer) => { run.log = clip(run.log + b.toString('utf8')) })
      child.on('error', () => resolve(null))
      child.on('close', code => resolve(code))
    })
  }

  async function execute(run: Run, req: RunRequest): Promise<void> {
    const game = gameOf(run.game)
    const work = join(dirs.work, run.id)
    await mkdir(join(work, 'dist'), { recursive: true })
    try {
      await writeFile(join(work, 'wavedash.toml'), `game_id = "${game.game_id}"\nupload_dir = "./dist"\n`)
      let result: { code: number | null; out: string }
      if (run.action === 'push') {
        const code = await untar(join(dirs.artifacts, run.game, run.artifact!), join(work, 'dist'), run)
        if (code !== 0) { run.exit_code = code; run.status = 'failed'; return }
        result = await exec(['build', 'push', '-c', join(work, 'wavedash.toml'), '-m', run.message], work, run)
        run.build_id = parseBuildId(result.out)
        if (result.code === 0 && !run.build_id) run.log += '\n[publisher] pushed, but the build id could not be read from the output: use the id shown in the Wavedash developer portal for Publish.\n'
      } else {
        const args = ['publish', run.build_id!, '-c', join(work, 'wavedash.toml'), '--yes']
        const title = clean(req.title, 120), summary = clean(req.summary, 500)
        if (title) args.push('--title', title)
        if (summary) args.push('--summary', summary)
        result = await exec(args, work, run)
      }
      run.exit_code = result.code
      run.status = result.code === 0 ? 'ok' : 'failed'
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async function prune(game: string): Promise<void> {
    const names = (await listArtifacts(game)).map(a => a.name)
    for (const old of names.slice(cfg.keepArtifacts)) await rm(join(dirs.artifacts, game, old), { force: true })
  }

  async function listArtifacts(game: string): Promise<{ name: string; bytes: number }[]> {
    gameOf(game)
    const dir = join(dirs.artifacts, game)
    const names = (await readdir(dir).catch(() => [] as string[])).filter(n => ARTIFACT_RE.test(n)).sort().reverse()
    return Promise.all(names.map(async name => ({ name, bytes: (await stat(join(dir, name))).size })))
  }

  async function saveArtifact(game: string, body: Readable): Promise<{ artifact: string; bytes: number; sha256: string }> {
    gameOf(game)
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

  async function startRun(req: RunRequest): Promise<Run> {
    gameOf(req.game)
    if (req.action !== 'push' && req.action !== 'publish') throw new PublisherError(400, 'action must be push or publish')
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
    if ([...live.values()].some(r => r.game === req.game && (r.status === 'queued' || r.status === 'running'))) throw new PublisherError(409, 'a run is already in progress for this game')
    const run: Run = {
      id: randomUUID(), game: req.game, action: req.action, artifact, build_id: buildId,
      message: clean(req.message, 200) || `${gameOf(req.game).name} ${new Date().toISOString().slice(0, 16)}Z`,
      status: 'queued', exit_code: null, started_at: Date.now(), ended_at: null, log: '',
    }
    live.set(run.id, run)
    const rid = Number(req.request_id)
    requestIds.set(run.id, Number.isSafeInteger(rid) && rid > 0 ? rid : null)
    await mkdir(dirs.runs, { recursive: true })
    await persist(run)
    record(run)
    chain = chain.then(async () => {
      run.status = 'running'
      await persist(run)
      record(run)
      try { await execute(run, req) } catch (e) { run.status = 'failed'; run.log = clip(run.log + `\n[publisher] ${(e as Error).message}\n`) }
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

  /** Read-only: is the CLI logged in for this HOME? (same idea as nomorechat's claude_subscription_available) */
  async function authStatus(): Promise<{ authenticated: boolean; detail: string }> {
    const probe: Run = { id: 'auth', game: '', action: 'push', artifact: null, build_id: null, message: '', status: 'running', exit_code: null, started_at: Date.now(), ended_at: null, log: '' }
    const r = await exec(['auth', 'status'], cfg.dataDir, probe)
    const text = r.out.replace(/\u001b\[[0-9;]*m/g, '').trim()
    return { authenticated: r.code === 0 && /authenticated/i.test(text) && !/not authenticated/i.test(text), detail: text.slice(0, 300) }
  }

  return {
    games: () => Object.entries(cfg.games).map(([id, g]) => ({ id, name: g.name })),
    listArtifacts, saveArtifact, startRun, getRun, listRuns, authStatus,
    /** Resolves when every queued run has finished (tests, graceful shutdown). */
    idle: () => chain.then(() => recordChain).then(() => undefined),
  }
}
export type Publisher = ReturnType<typeof createPublisher>
