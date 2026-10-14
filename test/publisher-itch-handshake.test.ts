import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { createPublisher, ITCH_TARGET_RE } from '../src/publisher/runner.ts'
import { createPublisherServer } from '../src/publisher/server.ts'
import { createHandshakeUpdater, validateUpdateRequest } from '../src/publisher/handshake.ts'

const KEY = 'k'.repeat(32)
let root: string, base: string, server: ReturnType<typeof createPublisherServer>, calls: string
let healthy = true, health: Server

// Fake butler: logs "KEY|args"; `status` prints a channel table; `push` succeeds.
const FAKE_BUTLER = `#!/bin/sh
echo "$BUTLER_API_KEY|$*" >> "__CALLS__"
case "$1" in
  push) ls "$4" > /dev/null || exit 3; echo "Pushing"; exit 0 ;;
  status) echo "Channel html5: up to date"; exit 0 ;;
esac
exit 9
`

async function api(path: string, init: Omit<RequestInit, 'body'> & { body?: BodyInit | Buffer } = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${KEY}`)
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
  root = await mkdtemp(join(tmpdir(), 'pub-itch-'))
  calls = join(root, 'calls.log')
  const bin = join(root, 'butler')
  await writeFile(bin, FAKE_BUTLER.replaceAll('__CALLS__', calls))
  await chmod(bin, 0o755)
  await mkdir(join(root, 'home'), { recursive: true })
  health = createServer((_q, res) => { res.writeHead(healthy ? 200 : 503); res.end(healthy ? '{"ok":true,"rooms":0}' : '{"ok":false}') })
  await new Promise<void>(r => health.listen(0, '127.0.0.1', r))
  const healthUrl = `http://127.0.0.1:${(health.address() as AddressInfo).port}/health`
  const publisher = createPublisher({
    dataDir: root, home: join(root, 'home'), wavedashBin: '/bin/false', butlerBin: bin, maxArtifactBytes: 200_000, keepArtifacts: 2, runTimeoutMs: 10_000,
  })
  server = createPublisherServer(publisher, {
    key: KEY, handshake: createHandshakeUpdater({ dir: join(root, 'handshake'), healthUrl, deployedFile: join(root, 'deployed-ref') }),
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  server.close(); health.close()
  await rm(root, { recursive: true, force: true })
})

describe('itch adapter', () => {
  test('target shape', () => {
    assert.ok(ITCH_TARGET_RE.test('monuser/mon-jeu:html5'))
    for (const bad of ['a-renseigner', 'user/game', 'user/game:', '../x/y:z', 'u/g:c; rm -rf /', 'u/g:c d']) assert.ok(!ITCH_TARGET_RE.test(bad), bad)
  })
  test('refuses a placeholder or malformed external_id, a missing key, publish and unknown platforms', async () => {
    const t = (over: object, headers: Record<string, string> = { 'x-itch-token': 'ITCHKEY1234' }) =>
      api('/runs', { method: 'POST', headers, body: JSON.stringify({ game: 'kekkai', platform: 'itch', action: 'push', game_id: 'u/g:html5', ...over }) })
    assert.equal((await t({ game_id: 'a-renseigner' })).status, 400)
    assert.equal((await t({ game_id: 'u/g' })).status, 400)
    assert.equal((await t({}, {})).status, 409)
    assert.equal((await t({ action: 'publish' })).status, 400)
    assert.equal((await t({ platform: 'steam' })).status, 400)
  })
  test('push: extracts the artifact and runs butler push with the key only in the child env', async () => {
    const up = await api('/artifacts/kekkai', { method: 'PUT', body: await tarball({ 'index.html': '<p>x</p>' }) })
    assert.equal(up.status, 201)
    const r = await api('/runs', {
      method: 'POST', headers: { 'x-itch-token': 'ITCHKEY1234' },
      body: JSON.stringify({ game: 'kekkai', platform: 'itch', action: 'push', game_id: 'u/g:html5', publisher_id: 7, message: 'v1' }),
    })
    assert.equal(r.status, 202)
    assert.equal(r.json.platform, 'itch')
    const done = await waitRun(r.json.id)
    assert.equal(done.status, 'ok')
    assert.ok(!JSON.stringify(done).includes('ITCHKEY1234'))
    const log = await readFile(calls, 'utf8')
    assert.match(log, /^ITCHKEY1234\|push --userversion v1 .*\/dist u\/g:html5$/m)
  })
  test('status via butler status', async () => {
    const r = await api('/itch/status?target=u/g:html5', { headers: { 'x-itch-token': 'ITCHKEY1234' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal((await api('/itch/status?target=u/g:html5')).status, 409)
    assert.equal((await api('/itch/status?target=a-renseigner', { headers: { 'x-itch-token': 'ITCHKEY1234' } })).status, 400)
  })
})

describe('handshake update request', () => {
  test('validation', () => {
    assert.deepEqual(validateUpdateRequest('https://github.com/iscreamparis/handshake', 'feat/http-player-store'), { repo: 'https://github.com/iscreamparis/handshake', ref: 'feat/http-player-store' })
    for (const repo of ['http://github.com/a/b', 'https://u:p@github.com/a/b', 'https://github.com/a', 'git@github.com:a/b', 'https://github.com/a/b;x', 5]) {
      assert.throws(() => validateUpdateRequest(repo, 'main'), /invalid repo/, String(repo))
    }
    for (const ref of ['', '-x', 'a..b', 'a b', 'a;b', 'x/', 'a$(id)', 5]) assert.throws(() => validateUpdateRequest('https://github.com/a/b', ref), /invalid ref/, String(ref))
  })
  test('status is idle at first and reports health', async () => {
    const s = await api('/handshake/status')
    assert.equal(s.status, 200)
    assert.equal(s.json.state, 'idle')
    assert.equal(s.json.health.ok, true)
  })
  test('update needs auth and valid input; drops a request file and reports queued; refuses a second one', async () => {
    const res = await fetch(base + '/handshake/update', { method: 'POST', body: '{}' })
    assert.equal(res.status, 401)
    assert.equal((await api('/handshake/update', { method: 'POST', body: JSON.stringify({ repo: 'file:///etc', ref: 'main' }) })).status, 400)
    const ok = await api('/handshake/update', { method: 'POST', body: JSON.stringify({ repo: 'https://github.com/iscreamparis/handshake', ref: 'main' }) })
    assert.equal(ok.status, 202)
    assert.equal(ok.json.state, 'queued')
    const req = await readFile(join(root, 'handshake', 'request.env'), 'utf8')
    assert.match(req, /^ID=\d+\nREPO=https:\/\/github\.com\/iscreamparis\/handshake\nREF=main\n$/)
    assert.equal((await api('/handshake/update', { method: 'POST', body: JSON.stringify({ repo: 'https://github.com/iscreamparis/handshake', ref: 'main' }) })).status, 409)
  })
  test('the root updater result is read back (ok) and an unhealthy Handshake blocks a new update', async () => {
    await writeFile(join(root, 'handshake', 'status.json'), JSON.stringify({ state: 'ok', id: '1', repo: 'r', ref: 'main', sha: 'abc', started_at: 1, ended_at: 2, message: 'updated to abc' }))
    await writeFile(join(root, 'deployed-ref'), 'abc\n')
    const s = await api('/handshake/status')
    assert.equal(s.json.state, 'ok')
    assert.equal(s.json.deployed_sha, 'abc')
    healthy = false
    const blocked = await api('/handshake/update', { method: 'POST', body: JSON.stringify({ repo: 'https://github.com/iscreamparis/handshake', ref: 'main' }) })
    healthy = true
    assert.equal(blocked.status, 409)
    assert.match(blocked.json.error, /not healthy/)
  })
})
