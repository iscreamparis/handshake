import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { createPublisher, parseBuildId } from '../src/publisher/runner.ts'
import { createPublisherServer } from '../src/publisher/server.ts'

const KEY = 'k'.repeat(32)
let root: string, base: string, server: ReturnType<typeof createPublisherServer>, calls: string

// Fake CLI: logs "HOME|CI|args" per call; "auth status" depends on $HOME/logged-in; push prints a build id.
const FAKE = `#!/bin/sh
echo "$HOME|$CI|$*" >> "__CALLS__"
case "$1 $2" in
  "auth status") if [ -f "$HOME/logged-in" ]; then echo "✓ Authenticated (via stored credentials)"; exit 0; else echo "Not authenticated"; exit 1; fi ;;
  "build push") ls dist > /dev/null || exit 3; cat wavedash.toml >> "__CALLS__"; echo "Uploading..."; echo "Build ID: bld_abc123XYZ"; echo "Playtest: https://wavedash.com/x"; exit 0 ;;
esac
case "$1" in
  publish) echo "Published $2"; exit 0 ;;
esac
exit 9
`

async function api(path: string, init: Omit<RequestInit, 'body'> & { auth?: boolean; body?: BodyInit | Buffer } = {}) {
  const headers = new Headers(init.headers)
  if (init.auth !== false) headers.set('authorization', `Bearer ${KEY}`)
  const body = Buffer.isBuffer(init.body) ? new Uint8Array(init.body) : init.body
  const res = await fetch(base + path, { ...init, body, headers })
  return { status: res.status, json: (await res.json()) as any }
}
async function tarball(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'pub-src-'))
  for (const [n, c] of Object.entries(files)) { await mkdir(join(dir, n, '..'), { recursive: true }); await writeFile(join(dir, n), c) }
  const r = spawnSync('tar', ['-czf', '-', '-C', dir, '.'], { maxBuffer: 1 << 24 })
  await rm(dir, { recursive: true, force: true })
  return r.stdout
}
async function waitRun(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await api(`/runs/${id}`)
    if (r.json.status === 'ok' || r.json.status === 'failed') return r.json
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('run did not finish')
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'pub-'))
  calls = join(root, 'calls.log')
  const bin = join(root, 'wavedash')
  await writeFile(bin, FAKE.replaceAll('__CALLS__', calls))
  await chmod(bin, 0o755)
  await mkdir(join(root, 'home'), { recursive: true })
  const publisher = createPublisher({
    dataDir: root, home: join(root, 'home'), wavedashBin: bin, maxArtifactBytes: 200_000, keepArtifacts: 2, runTimeoutMs: 10_000,
    games: { kekkai: { name: 'Kekkai', game_id: 'gid_kekkai' }, kart: { name: 'Monster Racer', game_id: 'gid_kart' } },
  })
  server = createPublisherServer(publisher, { key: KEY })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => { server.close(); await rm(root, { recursive: true, force: true }) })

describe('publisher', () => {
  test('parseBuildId handles the usual shapes and refuses noise', () => {
    assert.equal(parseBuildId('Build ID: abc123XYZ'), 'abc123XYZ')
    assert.equal(parseBuildId('build_id = j57abc_def\nurl'), 'j57abc_def')
    assert.equal(parseBuildId('see https://wavedash.com/dashboard/builds/k17zz9yy8x for it'), 'k17zz9yy8x')
    assert.equal(parseBuildId('Uploading... done'), null)
  })

  test('health is open, everything else needs the key', async () => {
    assert.equal((await api('/health', { auth: false })).status, 200)
    assert.equal((await api('/games', { auth: false })).status, 401)
    assert.equal((await api('/games', { headers: { authorization: 'Bearer wrong' }, auth: false })).status, 401)
    assert.deepEqual((await api('/games')).json.games.map((g: any) => g.id), ['kekkai', 'kart'])
  })

  test('auth status reflects the CLI home, never a token', async () => {
    assert.equal((await api('/auth/status')).json.authenticated, false)
    await writeFile(join(root, 'home', 'logged-in'), '')
    const ok = (await api('/auth/status')).json
    assert.equal(ok.authenticated, true)
    assert.ok(!JSON.stringify(ok).includes('WAVEDASH_TOKEN'))
  })

  test('push: upload, run the CLI with the game id and the service HOME, parse the build id, clean the workdir', async () => {
    const up = await api('/artifacts/kekkai', { method: 'PUT', body: await tarball({ 'index.html': '<html>', 'assets/a.js': '1' }) })
    assert.equal(up.status, 201)
    assert.match(up.json.artifact, /^\d{13}-[0-9a-f]{8}\.tar\.gz$/)
    const run = await api('/runs', { method: 'POST', body: JSON.stringify({ game: 'kekkai', action: 'push', message: 'v1' }) })
    assert.equal(run.status, 202)
    const done = await waitRun(run.json.id)
    assert.equal(done.status, 'ok')
    assert.equal(done.build_id, 'bld_abc123XYZ')
    const log = await readFile(calls, 'utf8')
    assert.match(log, new RegExp(`${join(root, 'home').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|1\\|build push -c .*wavedash.toml -m v1`))
    assert.match(log, /game_id = "gid_kekkai"/)
    assert.deepEqual(await readdir(join(root, 'work')), [])
  })

  test('publish needs a valid build id, passes --yes, and never leaks other env', async () => {
    assert.equal((await api('/runs', { method: 'POST', body: JSON.stringify({ game: 'kekkai', action: 'publish' }) })).status, 400)
    assert.equal((await api('/runs', { method: 'POST', body: JSON.stringify({ game: 'kekkai', action: 'publish', build_id: 'x; rm -rf /' }) })).status, 400)
    const run = await api('/runs', { method: 'POST', body: JSON.stringify({ game: 'kekkai', action: 'publish', build_id: 'bld_abc123XYZ', title: 'v1', summary: 'first' }) })
    const done = await waitRun(run.json.id)
    assert.equal(done.status, 'ok')
    assert.match(await readFile(calls, 'utf8'), /publish bld_abc123XYZ -c .*wavedash.toml --yes --title v1 --summary first/)
  })

  test('push without an artifact, unknown games, one run per game at a time', async () => {
    assert.equal((await api('/runs', { method: 'POST', body: JSON.stringify({ game: 'kart', action: 'push' }) })).status, 404)
    assert.equal((await api('/runs', { method: 'POST', body: JSON.stringify({ game: '../etc', action: 'push' }) })).status, 404)
    await api('/artifacts/kart', { method: 'PUT', body: await tarball({ 'index.html': 'x' }) })
    const [a, b] = await Promise.all([1, 2].map(() => api('/runs', { method: 'POST', body: JSON.stringify({ game: 'kart', action: 'push' }) })))
    assert.deepEqual([a.status, b.status].sort(), [202, 409])
    await waitRun((a.status === 202 ? a : b).json.id)
  })

  test('artifact limits: too large is refused and leaves nothing; only the last 2 are kept', async () => {
    const big = await api('/artifacts/kart', { method: 'PUT', body: Buffer.alloc(300_000, 1) })
    assert.equal(big.status, 413)
    assert.ok((await readdir(join(root, 'artifacts', 'kart'))).every(n => !n.endsWith('.part')))
    for (let i = 0; i < 3; i++) { await api('/artifacts/kart', { method: 'PUT', body: await tarball({ 'index.html': String(i) }) }); await new Promise(r => setTimeout(r, 5)) }
    assert.equal((await api('/artifacts/kart')).json.artifacts.length, 2)
    assert.equal((await api('/artifacts/kart', { method: 'PUT', body: Buffer.alloc(0) })).status, 400)
  })

  test('a failing CLI marks the run failed and keeps the log', async () => {
    await writeFile(join(root, 'artifacts', 'kart', 'broken.txt'), '')
    const up = await api('/artifacts/kart', { method: 'PUT', body: Buffer.from('not a tarball') })
    const run = await api('/runs', { method: 'POST', body: JSON.stringify({ game: 'kart', action: 'push', artifact: up.json.artifact }) })
    const done = await waitRun(run.json.id)
    assert.equal(done.status, 'failed')
    assert.ok(done.log.length > 0)
    assert.ok((await api('/runs')).json.runs.some((r: any) => r.id === run.json.id && !('log' in r)))
  })
})
