import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { get } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runChecks, spawnCheck, testFileCheck } from './lib.ts'

const buildFiles = ['dist/index.js', 'dist/index.d.ts', 'dist/store/contract.js', 'dist/store/contract.d.ts']
const tscArgs = ['node_modules/typescript/bin/tsc']
function buildValue(code: number | null): { value: string; threshold: string; ok: boolean } {
  const missing = buildFiles.filter((file) => !existsSync(resolve(file)))
  return {
    value: `exit ${code}; missing ${missing.length ? missing.join(', ') : 'none'}`,
    threshold: 'exit 0; all required dist files exist',
    ok: code === 0 && missing.length === 0,
  }
}

const rawBuild = spawnCheck('build', process.execPath, [...tscArgs, '-p', 'tsconfig.build.json'], {
  timeoutMs: 30000,
  expect: ({ code }) => buildValue(code),
})
let buildPromise: ReturnType<typeof rawBuild.run> | undefined
function runBuild(): ReturnType<typeof rawBuild.run> {
  buildPromise ??= rawBuild.run()
  return buildPromise
}
const buildCheck = { label: 'build', run: runBuild }

const typecheck = spawnCheck('typecheck', process.execPath, [...tscArgs, '-p', 'tsconfig.json'], {
  timeoutMs: 30000,
  expect: ({ code, stdout, stderr }) => {
    const firstError = `${stdout}\n${stderr}`.split(/\r?\n/).find((line) => /error TS\d+:/.test(line))
    return {
      value: code === 0 ? 'exit 0' : `exit ${code}; ${firstError ?? 'no tsc error line'}`,
      threshold: 'exit 0',
      ok: code === 0,
    }
  },
})

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body }))
    })
    req.setTimeout(2000, () => req.destroy(new Error('HTTP request timeout')))
    req.on('error', reject)
  })
}

function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolveDeadline, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    promise.then(resolveDeadline, reject).finally(() => clearTimeout(timer))
  })
}

type Message = Record<string, any>
interface Client { ws: any; next(type: string): Promise<Message>; closed: Promise<void> }
async function connect(Ws: any, port: number): Promise<Client> {
  const ws = new Ws(`ws://127.0.0.1:${port}/ws`)
  const queue: Message[] = []
  const waiters: { type: string; resolve(message: Message): void }[] = []
  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString()) as Message
    const index = waiters.findIndex((waiter) => waiter.type === message.t)
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
    else queue.push(message)
  })
  ws.on('error', () => {})
  const closed = new Promise<void>((resolveClosed) => ws.once('close', resolveClosed))
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', resolveOpen)
    ws.once('error', reject)
  })
  return {
    ws,
    closed,
    next(type) {
      const index = queue.findIndex((message) => message.t === type)
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0])
      return new Promise((resolveMessage) => waiters.push({ type, resolve: resolveMessage }))
    },
  }
}

const distRooms = {
  label: 'dist-rooms',
  async run() {
    let server: any
    const clients: Client[] = []
    try {
      const entry = resolve('dist/index.js')
      if (!existsSync(entry)) {
        const result = await runBuild()
        if (!result.ok) return { value: `build required: ${result.value}`, threshold: 'dist room flow and exact health keys', ok: false }
      }
      const mod = await import(pathToFileURL(entry).href)
      const { WebSocket } = await import('ws')
      server = mod.createHandshake({
        config: { port: 0, host: '127.0.0.1', logLevel: 'error' },
        store: mod.createMemoryStore(),
      })
      const { port } = await deadline(server.listen(), 10000, 'dist server listen')
      await deadline((async () => {
        const a = await connect(WebSocket, port); clients.push(a)
        const b = await connect(WebSocket, port); clients.push(b)
        const hello = (client: Client, name: string) => {
          client.ws.send(JSON.stringify({ t: 'hello', v: 1, game: 'proof', name }))
          return client.next('welcome')
        }
        await Promise.all([hello(a, 'Ann'), hello(b, 'Bob')])
        const player = (name: string) => ({ name, build: { characterId: 'sprout', bodyId: 'std', wheelId: 'std', gliderId: 'std' } })
        a.ws.send(JSON.stringify({ t: 'create', players: [player('Ann')], rid: 1 }))
        const room = await a.next('room')
        b.ws.send(JSON.stringify({ t: 'join', code: ` ${String(room.code).toLowerCase()} `, players: [player('Bob')] }))
        await b.next('room')
        await a.next('room')
        a.ws.send(JSON.stringify({ t: 'signal', to: 1, data: { kind: 'offer', sdp: 'v=0' } }))
        const signal = await b.next('signal')
        assert.equal(signal.from, 0)
        assert.deepEqual(signal.data, { kind: 'offer', sdp: 'v=0' })
        const health = await httpGet(port, '/health')
        assert.equal(health.status, 200)
        assert.deepEqual(Object.keys(JSON.parse(health.body)).sort(), ['clients', 'ok', 'rooms', 'version'])
      })(), 10000, 'dist room flow')
      return { value: 'room create/join/signal; health keys exact', threshold: '2 clients complete flow; health keys clients,ok,rooms,version', ok: true }
    } catch (error) {
      return { value: error instanceof Error ? error.message : String(error), threshold: 'dist room flow and exact health keys', ok: false }
    } finally {
      for (const client of clients) if (client.ws.readyState < 2) client.ws.close()
      await Promise.all(clients.map((client) => client.closed.catch(() => {})))
      if (server) await server.close()
    }
  },
}

const npmStart = {
  label: 'npm-start',
  run: () => new Promise<{ value: string; threshold: string; ok: boolean }>((resolveResult) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let listening = false
    let stopRequested = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: string, ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(startTimer)
      if (killTimer) clearTimeout(killTimer)
      resolveResult({ value, threshold: 'health 200; SIGTERM exit 0 within 5 s', ok })
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      const match = stdout.match(/rooms listening on 127\.0\.0\.1:(\d+)/)
      if (!match || settled) return
      listening = true
      void (async () => {
        try {
          const health = await httpGet(Number(match[1]), '/health')
          if (health.status !== 200) throw new Error(`/health returned ${health.status}`)
          child.once('close', (code) => finish(`health 200; SIGTERM exit ${code}`, code === 0))
          stopRequested = true
          child.kill('SIGTERM')
          killTimer = setTimeout(() => {
            child.kill('SIGKILL')
            finish('health 200; SIGTERM exit timeout', false)
          }, 5000)
        } catch (error) {
          child.kill('SIGTERM')
          finish(error instanceof Error ? error.message : String(error), false)
        }
      })()
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => finish(`spawn error: ${error.message}`, false))
    child.once('close', (code) => {
      if (!settled && !listening && !stopRequested) finish(`exit ${code} before listening${stdout || stderr ? `; ${(stdout + stderr).trim().split(/\r?\n/)[0]}` : ''}`, false)
    })
    const startTimer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(`no listening line within 10000 ms${stdout || stderr ? `; ${(stdout + stderr).trim().split(/\r?\n/)[0]}` : ''}`, false)
    }, 10000)
  }),
}

const kartTests = testFileCheck('kart-tests', ['test/server.test.ts', 'test/hub.test.ts', 'test/protocol.test.ts'], { minPassed: 33 })

const checks = [buildCheck, typecheck, distRooms, npmStart, kartTests]
await runChecks(checks, process.argv.slice(2))
