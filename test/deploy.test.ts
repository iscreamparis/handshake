import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderDeploy, runDeploy, main } from '../deploy/deploy.ts'
import { RELAY_PATH } from '../src/relay/protocol.ts'

const HOST = 'deploy@example.test'
const DOMAIN = 'rooms.test'
const SERVICE = '/etc/systemd/system/kart-rooms.service'
const ENV = '/etc/kart-rooms.env'
const CADDY = '/etc/caddy/Caddyfile'
const NGINX = '/etc/nginx/conf.d/kart-rooms.conf'

type Recorded = [string, string[]]

function spy(failAt = 0): { calls: Recorded[]; exec: (cmd: string, args: string[]) => Promise<number> } {
  const calls: Recorded[] = []
  const exec = (cmd: string, args: string[]): Promise<number> => {
    calls.push([cmd, args])
    return Promise.resolve(calls.length === failAt ? 1 : 0)
  }
  return { calls, exec }
}

function fileContent(plan: ReturnType<typeof renderDeploy>, target: string): string {
  const file = plan.files.find((entry) => entry.target === target)
  assert.ok(file, `plan has no file for ${target}`)
  return file.content
}

function block(content: string, head: string): string {
  const start = content.indexOf(head)
  assert.notEqual(start, -1, `missing "${head}"`)
  return content.slice(start, content.indexOf('}', start))
}

test('deploy: unit keeps ExecStart, User and WorkingDirectory', () => {
  const unit = fileContent(renderDeploy({ host: HOST, domain: DOMAIN }), SERVICE)
  assert.ok(unit.includes('ExecStart=/usr/bin/node --experimental-strip-types src/main.ts'))
  assert.ok(unit.includes('User=rooms'))
  assert.ok(unit.includes('WorkingDirectory=/opt/kart-rooms'))
})

test('deploy: env carries every loadConfig variable and the domain', () => {
  const env = fileContent(renderDeploy({ host: HOST, domain: DOMAIN }), ENV)
  const names = ['PORT', 'HOST', 'STUN_URLS', 'TURN_URLS', 'TURN_SECRET', 'MAX_ROOMS', 'MAX_CLIENTS', 'ALLOWED_ORIGINS', 'LOG_LEVEL']
  const lines = env.split('\n')
  for (const name of names) {
    assert.ok(lines.some((line) => line.startsWith(`${name}=`)), `missing ${name}=`)
  }
  assert.ok(env.includes(DOMAIN))
  assert.ok(!env.includes('rooms.example.com'))
})

test('deploy: nginx routes RELAY_PATH and a custom relay path with upgrade headers', () => {
  const conf = fileContent(renderDeploy({ host: HOST, domain: DOMAIN, proxy: 'nginx' }), NGINX)
  const ws = block(conf, `location ${RELAY_PATH}`)
  assert.ok(ws.includes('Upgrade $http_upgrade'))
  assert.ok(ws.includes('Connection "upgrade"'))

  const customConf = fileContent(renderDeploy({ host: HOST, domain: DOMAIN, proxy: 'nginx', relayPath: '/relay-test' }), NGINX)
  const custom = block(customConf, 'location = /relay-test')
  assert.ok(custom.includes('Upgrade $http_upgrade'))
  assert.ok(custom.includes('Connection "upgrade"'))
})

test('deploy: caddy matches RELAY_PATH and lists a custom relay path too', () => {
  const caddy = fileContent(renderDeploy({ host: HOST, domain: DOMAIN }), CADDY)
  assert.ok(caddy.includes('@ws path /ws'))
  assert.ok(caddy.includes('reverse_proxy @ws 127.0.0.1:8787'))

  const custom = fileContent(renderDeploy({ host: HOST, domain: DOMAIN, relayPath: '/relay-test' }), CADDY)
  assert.ok(custom.includes('@ws path /ws /relay-test'))
})

test('runDeploy: one exec per step, in plan order', async () => {
  const plan = renderDeploy({ host: HOST, domain: DOMAIN })
  const { calls, exec } = spy()
  await runDeploy(plan, exec)
  assert.equal(calls.length, plan.steps.length)
  assert.deepEqual(calls, plan.steps.map((step) => [step.cmd, step.args]))
})

test('runDeploy: stops and rejects on the first non-zero code', async () => {
  const plan = renderDeploy({ host: HOST, domain: DOMAIN })
  const { calls, exec } = spy(3)
  await assert.rejects(runDeploy(plan, exec), /sync-staging/)
  assert.equal(calls.length, 3)
})

test('main: dry run writes the files and plan.txt and execs nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kart-rooms-dry-run-'))
  try {
    const { calls, exec } = spy()
    const code = await main(['--host', HOST, '--domain', DOMAIN, '--dry-run', '--out', dir], exec)
    assert.equal(code, 0)
    assert.equal(calls.length, 0)

    const names = await readdir(dir)
    for (const base of ['kart-rooms.service', 'kart-rooms.env', 'Caddyfile', 'turnserver.conf', 'plan.txt']) {
      assert.ok(names.includes(base), `missing ${base}`)
    }

    const plan = renderDeploy({ host: HOST, domain: DOMAIN })
    const text = await readFile(join(dir, 'plan.txt'), 'utf8')
    assert.equal(text.split('\n').filter((line) => line.length > 0).length, plan.steps.length)
    assert.equal(plan.steps.length, 10)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('main: missing --host prints usage and returns 2', async () => {
  const { calls, exec } = spy()
  assert.equal(await main(['--domain', DOMAIN, '--dry-run', '--out', '/tmp/never'], exec), 2)
  assert.equal(await main([], exec), 2)
  assert.equal(calls.length, 0)
})
