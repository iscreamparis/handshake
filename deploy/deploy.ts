// Deploy rendering and execution for the KartRacer rooms server.
// renderDeploy builds the DeployPlan (files with absolute target paths plus the
// ordered ssh/rsync steps); runDeploy walks the steps with an injected exec.
// main is the CLI: --dry-run renders into --out and executes nothing, --apply
// stages the files and runs the plan (never used against the live server).

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RELAY_PATH } from '../src/relay/protocol.ts'

const DEPLOY_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(DEPLOY_DIR, '..')

const SERVICE_TARGET = '/etc/systemd/system/kart-rooms.service'
const ENV_TARGET = '/etc/kart-rooms.env'
const CADDY_TARGET = '/etc/caddy/Caddyfile'
const NGINX_TARGET = '/etc/nginx/conf.d/kart-rooms.conf'
const TURN_TARGET = '/etc/turnserver.conf'

const APP_DIR = '/opt/kart-rooms'
const REMOTE_STAGING_DIR = '/tmp/kart-rooms-deploy/'

// Local staging directory; the files are rsynced to REMOTE_STAGING_DIR.
export const STAGING_DIR = `${join(tmpdir(), 'kart-rooms-deploy')}/`

export type ProxyName = 'caddy' | 'nginx'
export type DeployExec = (cmd: string, args: string[]) => Promise<number>

export interface DeployFile {
  target: string
  content: string
}

export interface DeployStep {
  label: string
  cmd: string
  args: string[]
}

export interface DeployPlan {
  files: DeployFile[]
  steps: DeployStep[]
}

export interface DeployOptions {
  host: string
  domain: string
  proxy?: ProxyName
  relayPath?: string
}

function template(name: string): string {
  return readFileSync(join(DEPLOY_DIR, name), 'utf8')
}

function caddyfile(domain: string, relayPath: string): string {
  const matcher = relayPath === '/ws' ? '@ws path /ws' : `@ws path /ws ${relayPath}`
  return [
    `${domain} {`,
    `\t${matcher}`,
    '\treverse_proxy @ws 127.0.0.1:8787',
    '\treverse_proxy /health 127.0.0.1:8787',
    '}',
    '',
  ].join('\n')
}

function nginxLocation(head: string): string {
  return `    ${head} {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 75s;
    }`
}

function nginxConf(domain: string, relayPath: string): string {
  const relay = relayPath === '/ws' ? '' : `\n\n${nginxLocation(`location = ${relayPath}`)}`
  return `server {
    listen 80;
    server_name ${domain};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

${nginxLocation('location /ws')}${relay}

    location /health {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
`
}

function staged(target: string): string {
  return REMOTE_STAGING_DIR + basename(target)
}

export function renderDeploy(opts: DeployOptions): DeployPlan {
  const proxy = opts.proxy ?? 'caddy'
  const relayPath = opts.relayPath ?? RELAY_PATH
  const proxyTarget = proxy === 'nginx' ? NGINX_TARGET : CADDY_TARGET
  const proxyContent = proxy === 'nginx'
    ? nginxConf(opts.domain, relayPath)
    : caddyfile(opts.domain, relayPath)

  const files: DeployFile[] = [
    { target: SERVICE_TARGET, content: template('rooms.service') },
    { target: ENV_TARGET, content: template('rooms.env.example').replaceAll('rooms.example.com', opts.domain) },
    { target: proxyTarget, content: proxyContent },
    { target: TURN_TARGET, content: template('turnserver.conf.example').replaceAll('rooms.example.com', opts.domain) },
  ]

  const steps: DeployStep[] = [
    {
      label: 'backup',
      cmd: 'ssh',
      args: [opts.host, 'sudo rm -rf /opt/kart-rooms.prev && sudo cp -a /opt/kart-rooms /opt/kart-rooms.prev || true'],
    },
    {
      label: 'sync-repo',
      cmd: 'rsync',
      args: ['-az', '--delete', '--exclude', 'node_modules', '--exclude', 'dist', '--exclude', '.git', `${REPO_ROOT}/`, `${opts.host}:${APP_DIR}/`],
    },
    {
      label: 'sync-staging',
      cmd: 'rsync',
      args: ['-az', STAGING_DIR, `${opts.host}:${REMOTE_STAGING_DIR}`],
    },
    {
      label: 'npm-install',
      cmd: 'ssh',
      args: [opts.host, `cd ${APP_DIR} && npm install --omit=dev`],
    },
    {
      label: 'install-unit',
      cmd: 'ssh',
      args: [opts.host, `sudo install -m 644 ${staged(SERVICE_TARGET)} ${SERVICE_TARGET}`],
    },
    {
      label: 'install-env',
      cmd: 'ssh',
      args: [opts.host, `test -f ${ENV_TARGET} || sudo install -m 640 ${staged(ENV_TARGET)} ${ENV_TARGET}`],
    },
    {
      label: 'install-proxy',
      cmd: 'ssh',
      args: [opts.host, `sudo install -m 644 ${staged(proxyTarget)} ${proxyTarget}`],
    },
    {
      label: 'daemon-reload',
      cmd: 'ssh',
      args: [opts.host, 'sudo systemctl daemon-reload'],
    },
    {
      label: 'restart',
      cmd: 'ssh',
      args: [opts.host, 'sudo systemctl restart kart-rooms'],
    },
    {
      label: 'reload',
      cmd: 'ssh',
      args: [opts.host, `sudo systemctl reload ${proxy}`],
    },
  ]

  return { files, steps }
}

export async function runDeploy(plan: DeployPlan, exec: DeployExec): Promise<void> {
  for (const step of plan.steps) {
    const code = await exec(step.cmd, step.args)
    if (code !== 0) {
      throw new Error(`deploy step "${step.label}" failed: ${step.cmd} exited with code ${code}`)
    }
  }
}

function planText(plan: DeployPlan): string {
  return plan.steps.map((step) => `${step.label}: ${step.cmd} ${step.args.join(' ')}`).join('\n')
}

function writeFiles(plan: DeployPlan, dir: string): string[] {
  const written: string[] = []
  for (const file of plan.files) {
    const path = join(dir, basename(file.target))
    writeFileSync(path, file.content)
    written.push(path)
  }
  return written
}

const USAGE = `usage: deploy.ts --host <user@host> --domain <domain> [--proxy caddy|nginx] --dry-run --out <dir>
       deploy.ts --host <user@host> --domain <domain> [--proxy caddy|nginx] --apply`

interface CliArgs {
  host: string
  domain: string
  proxy: ProxyName
  dryRun: boolean
  out: string | null
}

function parseArgs(argv: string[]): CliArgs | null {
  let host: string | undefined
  let domain: string | undefined
  let proxy: ProxyName = 'caddy'
  let dryRun = false
  let apply = false
  let out: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--host' && i + 1 < argv.length) host = argv[++i]
    else if (arg === '--domain' && i + 1 < argv.length) domain = argv[++i]
    else if (arg === '--proxy' && i + 1 < argv.length) {
      const value = argv[++i]
      if (value !== 'caddy' && value !== 'nginx') return null
      proxy = value
    }
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--apply') apply = true
    else if (arg === '--out' && i + 1 < argv.length) out = argv[++i]
    else return null
  }

  if (host === undefined || domain === undefined) return null
  if (dryRun === apply) return null
  if (dryRun && out === undefined) return null
  if (apply && out !== undefined) return null
  return { host, domain, proxy, dryRun, out: out ?? null }
}

export async function main(argv: string[], exec: DeployExec): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed === null) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }

  try {
    const plan = renderDeploy({
      host: parsed.host,
      domain: parsed.domain,
      proxy: parsed.proxy,
      relayPath: RELAY_PATH,
    })

    if (parsed.dryRun) {
      const outDir = parsed.out as string
      mkdirSync(outDir, { recursive: true })
      const written = writeFiles(plan, outDir)
      const planPath = join(outDir, 'plan.txt')
      writeFileSync(planPath, planText(plan))
      written.push(planPath)
      for (const path of written) console.log(path)
      return 0
    }

    mkdirSync(STAGING_DIR, { recursive: true })
    writeFiles(plan, STAGING_DIR)
    await runDeploy(plan, exec)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const exec: DeployExec = (cmd, args) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
  main(process.argv.slice(2), exec).then((code) => process.exit(code))
}
