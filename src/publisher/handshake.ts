// Handshake self-update, requested through the publisher.
//
// The publisher is a sandboxed unprivileged service (user etcito, read-only filesystem, no new privileges): it
// can neither write /opt/kart-rooms nor restart kart-rooms, and it must not be able to. So this module only
// VALIDATES a request and drops it as a file; a systemd path unit starts a root oneshot
// (deploy/publisher/handshake-update.sh) that does git fetch -> new tree -> npm install -> backup -> swap ->
// restart -> /health check -> automatic rollback, and writes status.json which this module reads back.
// Nothing here runs a shell; the root script re-validates every value.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PublisherError } from './runner.ts'

export const REPO_RE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,100}\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/
export const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/
export type UpdateState = 'idle' | 'queued' | 'running' | 'ok' | 'rolled_back' | 'failed'
export interface UpdateStatus {
  state: UpdateState
  id: string | null
  repo: string | null
  ref: string | null
  /** Commit now deployed (from the deployed marker), when known. */
  deployed_sha: string | null
  sha: string | null
  started_at: number | null
  ended_at: number | null
  message: string
  log: string
  health: { ok: boolean; detail: string }
}
export interface HandshakeConfig {
  /** Exchange folder with the root updater (writable by the publisher): request.env / status.json / update.log. */
  dir: string
  /** Handshake's own /health. */
  healthUrl: string
  /** File written by the updater inside the deployed tree with the deployed commit. */
  deployedFile: string
  /** A queued/running update older than this is considered dead (the root unit has its own timeout). */
  staleMs?: number
}

export function validateUpdateRequest(repo: unknown, ref: unknown): { repo: string; ref: string } {
  const r = typeof repo === 'string' ? repo.trim() : ''
  const f = typeof ref === 'string' ? ref.trim() : ''
  if (!REPO_RE.test(r) || r.includes('..')) throw new PublisherError(400, 'invalid repo: expected https://host/owner/name (no credentials)')
  if (!REF_RE.test(f) || f.includes('..') || f.endsWith('/') || f.endsWith('.lock')) throw new PublisherError(400, 'invalid ref (branch name or commit sha)')
  return { repo: r, ref: f }
}

export function createHandshakeUpdater(cfg: HandshakeConfig) {
  const statusPath = join(cfg.dir, 'status.json')
  const requestPath = join(cfg.dir, 'request.env')
  const logPath = join(cfg.dir, 'update.log')
  const stale = cfg.staleMs ?? 15 * 60_000

  async function health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(cfg.healthUrl, { signal: AbortSignal.timeout(3000) })
      const text = (await res.text()).slice(0, 200)
      return { ok: res.ok && /"ok"\s*:\s*true/.test(text), detail: text }
    } catch (e) { return { ok: false, detail: (e as Error).message } }
  }
  async function readJson(): Promise<Partial<UpdateStatus> | null> {
    try { return JSON.parse(await readFile(statusPath, 'utf8')) as Partial<UpdateStatus> } catch { return null }
  }
  async function status(): Promise<UpdateStatus> {
    const s = await readJson()
    const active = s?.state === 'queued' || s?.state === 'running'
    const dead = active && typeof s?.started_at === 'number' && Date.now() - s.started_at > stale
    let log = ''
    try { log = (await readFile(logPath, 'utf8')).slice(-6000) } catch { /* no update yet */ }
    let deployed: string | null = null
    try { deployed = (await readFile(cfg.deployedFile, 'utf8')).trim().slice(0, 40) || null } catch { /* never updated by this mechanism */ }
    return {
      state: dead ? 'failed' : (s?.state ?? 'idle'), id: s?.id ?? null, repo: s?.repo ?? null, ref: s?.ref ?? null,
      deployed_sha: deployed, sha: s?.sha ?? null, started_at: s?.started_at ?? null, ended_at: s?.ended_at ?? null,
      message: dead ? 'update abandoned (no answer from the updater)' : (s?.message ?? ''), log, health: await health(),
    }
  }
  async function start(repo: unknown, ref: unknown): Promise<UpdateStatus> {
    const v = validateUpdateRequest(repo, ref)
    const cur = await status()
    if (cur.state === 'queued' || cur.state === 'running') throw new PublisherError(409, 'a Handshake update is already in progress')
    if (!cur.health.ok) throw new PublisherError(409, 'Handshake is not healthy right now: not updating over a broken service (restore it first)')
    const id = `${Date.now()}`
    await mkdir(cfg.dir, { recursive: true })
    await writeFile(statusPath, JSON.stringify({ state: 'queued', id, repo: v.repo, ref: v.ref, sha: null, started_at: Date.now(), ended_at: null, message: 'queued' }))
    const tmp = join(cfg.dir, `.request.${id}`)
    await writeFile(tmp, `ID=${id}\nREPO=${v.repo}\nREF=${v.ref}\n`)
    await rename(tmp, requestPath)   // the path unit fires on this file
    return status()
  }
  return { status, start }
}
export type HandshakeUpdater = ReturnType<typeof createHandshakeUpdater>
