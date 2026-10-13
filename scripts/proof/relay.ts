import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHandshake } from '../../src/handshake.ts'
import { RELAY_PATH } from '../../src/relay/protocol.ts'
import { runChecks, testFileCheck, type Check, type CheckResult } from './lib.ts'

const referenceRelay = new URL('../../reference/pwaphaser-relay/relay.mjs', import.meta.url)
const referenceTests = new URL('../../reference/pwaphaser-relay/relay.test.mjs', import.meta.url)

const relayScenarios: Check = {
  label: 'relay-scenarios',
  async run() {
    const source = await readFile(referenceTests, 'utf8')
    // The reference's scenario declarations are its indented ok(name, condition) calls.
    const count = [...source.matchAll(/^\s+ok\(/gm)].length
    return testFileCheck('relay-scenarios', ['test/relay.test.ts'], { minPassed: count }).run()
  },
}

const relayPath: Check = {
  label: 'relay-path',
  async run() {
    const source = await readFile(referenceRelay, 'utf8')
    const path = source.match(/\bproxifie\s+(\/[^\s`]+)(?=\s+ET\b)/)?.[1]
    const ok = path !== undefined && RELAY_PATH === path
    return { value: `reference ${path ?? 'not found'}; RELAY_PATH ${RELAY_PATH}`, threshold: 'paths equal', ok }
  },
}

type Message = Record<string, any>
type Client = { ws: any; closed: Promise<void>; next(type: string): Promise<Message> }

function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deadline ${ms} ms exceeded`)), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function connect(Ws: any, port: number, path: string): Promise<Client> {
  const ws = new Ws(`ws://127.0.0.1:${port}${path}`)
  const queued: Message[] = []
  const waiting: { type: string; resolve(message: Message): void }[] = []
  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString()) as Message
    const index = waiting.findIndex((item) => item.type === message.t)
    if (index < 0) queued.push(message)
    else waiting.splice(index, 1)[0].resolve(message)
  })
  ws.on('error', () => {})
  const closed = new Promise<void>((resolve) => ws.once('close', resolve))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return {
    ws, closed,
    next(type) {
      const index = queued.findIndex((message) => message.t === type)
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0])
      return new Promise((resolve) => waiting.push({ type, resolve }))
    },
  }
}

const coexist: Check = {
  label: 'coexist',
  async run(): Promise<CheckResult> {
    const clients: Client[] = []
    const server = createHandshake({ config: { port: 0, host: '127.0.0.1', logLevel: 'error' } })
    try {
      const { port } = await deadline(server.listen(), 10000)
      const Ws = (await import('ws')).WebSocket
      await deadline((async () => {
        const kart = await connect(Ws, port, '/ws'); clients.push(kart)
        kart.ws.send(JSON.stringify({ t: 'hello', v: 1, game: 'proof', name: 'Proof' }))
        await kart.next('welcome')
        kart.ws.send(JSON.stringify({ t: 'create', players: [{ name: 'Proof', build: { characterId: 'sprout', bodyId: 'std', wheelId: 'std', gliderId: 'std' } }] }))
        const room = await kart.next('room')

        const a = await connect(Ws, port, RELAY_PATH); clients.push(a)
        const b = await connect(Ws, port, RELAY_PATH); clients.push(b)
        a.ws.send(JSON.stringify({ t: 'queue' }))
        await a.next('queued')
        b.ws.send(JSON.stringify({ t: 'queue' }))
        await Promise.all([a.next('matched'), b.next('matched')])
        const action = { proof: 'unchanged', value: [1, 2, 3] }
        a.ws.send(JSON.stringify({ t: 'act', a: action }))
        const relayed = await b.next('act')
        assert.deepEqual(relayed.a, action)
        return room
      })(), 10000)
      return { value: 'KartRacer room; GameNet pair/action unchanged', threshold: 'room created and action relayed', ok: true }
    } catch (error) {
      return { value: error instanceof Error ? error.message : String(error), threshold: 'room created and action relayed', ok: false }
    } finally {
      for (const client of clients) if (client.ws.readyState < 2) client.ws.close()
      await Promise.all(clients.map((client) => client.closed.catch(() => {})))
      await server.close()
    }
  },
}

const kartTests = testFileCheck('kart-tests', ['test/server.test.ts', 'test/hub.test.ts', 'test/protocol.test.ts'], { minPassed: 33 })

await runChecks([relayScenarios, relayPath, coexist, kartTests], process.argv.slice(2))
