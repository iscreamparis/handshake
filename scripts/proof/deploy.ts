// M6 proof: the deploy artefact is replayable from a dry run.
// Five checks: dry-run, unit, proxy-routes, env-complete, no-exec.
// Nothing here touches the network or a real exec (never pass --apply).

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, renderDeploy, type DeployOptions } from '../../deploy/deploy.ts'
import { RELAY_PATH } from '../../src/relay/protocol.ts'
import { runChecks, spawnCheck, type Check, type CheckResult } from './lib.ts'

const tmpDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

const SERVICE_TARGET = '/etc/systemd/system/kart-rooms.service'
const CADDY_TARGET = '/etc/caddy/Caddyfile'
const NGINX_TARGET = '/etc/nginx/conf.d/kart-rooms.conf'
const ENV_TARGET = '/etc/kart-rooms.env'
const EXEC_START = 'ExecStart=/usr/bin/node --experimental-strip-types src/main.ts'

function rendered(opts: DeployOptions): Map<string, string> {
  const map = new Map<string, string>()
  for (const file of renderDeploy(opts).files) map.set(file.target, file.content)
  return map
}

function caddyCount(content: string, paths: string[]): number {
  const line = content.match(/@ws path ([^\n]+)/)?.[1] ?? ''
  const listed = paths.filter((p) => line.split(/\s+/).includes(p))
  return /reverse_proxy @ws/.test(content) ? listed.length : 0
}

function nginxCount(content: string, paths: string[]): number {
  let count = 0
  for (const p of paths) {
    const head = p === '/ws' ? 'location /ws {' : `location = ${p} {`
    const start = content.indexOf(head)
    if (start < 0) continue
    const block = content.slice(start, content.indexOf('}', start))
    if (/Upgrade \$http_upgrade/.test(block) && /Connection "upgrade"/.test(block)) count++
  }
  return count
}

const dryRunDir = tempDir('deploy-proof-')
const dryRunCheck: Check = spawnCheck(
  'dry-run',
  process.execPath,
  [
    '--experimental-strip-types', 'deploy/deploy.ts',
    '--host', 'proof@127.0.0.1', '--domain', 'rooms.proof.test',
    '--proxy', 'nginx', '--dry-run', '--out', dryRunDir,
  ],
  {
    expect: ({ code }) => {
      const named = ['kart-rooms.service', 'kart-rooms.env', 'kart-rooms.conf', 'turnserver.conf']
      const present = named.filter((name) => existsSync(join(dryRunDir, name)))
      const planPath = join(dryRunDir, 'plan.txt')
      const planOk = existsSync(planPath) && statSync(planPath).size > 0
      const files = present.length + (planOk ? 1 : 0)
      return { value: `${files} files`, threshold: '5 files', ok: code === 0 && files === 5 }
    },
  },
)

const unitCheck: Check = {
  label: 'unit',
  async run(): Promise<CheckResult> {
    const plan = renderDeploy({ host: 'proof@127.0.0.1', domain: 'rooms.proof.test', proxy: 'nginx', relayPath: RELAY_PATH })
    const unit = plan.files.find((file) => file.target === SERVICE_TARGET)?.content ?? ''
    const source = readFileSync(new URL('../../deploy/rooms.service', import.meta.url), 'utf8')
    const sourceLine = source.match(/^ExecStart=.*$/m)?.[0] ?? ''
    const renderedLine = unit.match(/^ExecStart=.*$/m)?.[0] ?? ''
    return { value: renderedLine, threshold: sourceLine, ok: unit.includes(EXEC_START) && renderedLine === sourceLine }
  },
}

const proxyCheck: Check = {
  label: 'proxy-routes',
  async run(): Promise<CheckResult> {
    const paths = ['/ws', '/relay-proof']
    const caddy = rendered({ host: 'h', domain: 'rooms.proof.test', proxy: 'caddy', relayPath: '/relay-proof' })
    const nginx = rendered({ host: 'h', domain: 'rooms.proof.test', proxy: 'nginx', relayPath: '/relay-proof' })
    const fallback = rendered({ host: 'h', domain: 'rooms.proof.test', proxy: 'nginx', relayPath: RELAY_PATH })
    const c = caddyCount(caddy.get(CADDY_TARGET) ?? '', paths)
    const n = nginxCount(nginx.get(NGINX_TARGET) ?? '', paths)
    const fallbackOk = nginxCount(fallback.get(NGINX_TARGET) ?? '', ['/ws']) === 1
    return { value: `caddy ${c}/2 nginx ${n}/2`, threshold: 'caddy 2/2 nginx 2/2', ok: c === 2 && n === 2 && fallbackOk }
  },
}

const envCheck: Check = {
  label: 'env-complete',
  async run(): Promise<CheckResult> {
    const source = readFileSync(new URL('../../src/config.ts', import.meta.url), 'utf8')
    const names = new Set<string>()
    for (const match of source.matchAll(/env\.([A-Z_]+)/g)) names.add(match[1])
    for (const match of source.matchAll(/int\(env, '([A-Z_]+)'/g)) names.add(match[1])
    const env = rendered({ host: 'h', domain: 'rooms.proof.test', proxy: 'caddy', relayPath: RELAY_PATH }).get(ENV_TARGET) ?? ''
    const missing = [...names].filter((name) => !new RegExp(`^${name}=`, 'm').test(env))
    const suffix = missing.length > 0 ? ` missing ${missing.join(',')}` : ''
    return {
      value: `${names.size - missing.length}/${names.size}${suffix}`,
      threshold: `${names.size}/${names.size}`,
      ok: missing.length === 0,
    }
  },
}

const noExecDir = tempDir('deploy-proof-noexec-')
const noExecCheck: Check = {
  label: 'no-exec',
  async run(): Promise<CheckResult> {
    let calls = 0
    const spy = async (): Promise<number> => { calls++; return 0 }
    const code = await main(
      ['--host', 'proof@127.0.0.1', '--domain', 'rooms.proof.test', '--proxy', 'nginx', '--dry-run', '--out', noExecDir],
      spy,
    )
    return { value: `exit ${code}, exec calls ${calls}`, threshold: 'exit 0, exec 0', ok: code === 0 && calls === 0 }
  },
}

const checks: Check[] = [dryRunCheck, unitCheck, proxyCheck, envCheck, noExecCheck]
await runChecks(checks, process.argv.slice(2))
