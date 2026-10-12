import { loadConfig } from '../src/config.ts'
import { startServer } from '../src/server.ts'
import { createMemoryStore } from '../src/store/memory.ts'

type Socket = {
  readyState: number
  on(event: string, listener: (...args: any[]) => void): Socket
  once(event: string, listener: (...args: any[]) => void): Socket
  send(data: string): void
  close(): void
}

async function main(): Promise<void> {
  let step = 'rooms'
  let srv: Awaited<ReturnType<typeof startServer>> | undefined
  let client: Socket | undefined

  try {
    let WebSocket: new (url: string) => Socket
    try {
      ({ WebSocket } = await import('ws'))
    } catch {
      console.error('ws not installed')
      process.exit(1)
    }

    srv = await startServer(loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error' }))
    client = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('welcome timeout')), 5000)
      client!.on('error', (error: Error) => reject(error))
      client!.on('open', () => {
        client!.send(JSON.stringify({ t: 'hello', v: 1, game: 'smoke', name: 'Smoke' }))
      })
      client!.on('message', (data: unknown) => {
        try {
          const message = JSON.parse(String(data)) as { t?: string }
          if (message.t === 'welcome') {
            clearTimeout(timeout)
            resolve()
          }
        } catch { /* Ignore non-JSON frames while waiting for welcome. */ }
      })
    })
    client.close()
    await srv.close()
    client = undefined
    srv = undefined
    console.log('rooms: ok')

    const store = createMemoryStore()
    step = 'identity'
    const first = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'smoke' })
    const second = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'smoke' })
    if (first.player.player_id !== second.player.player_id) throw new Error('identity returned different players')
    console.log('identity: ok')

    step = 'wallet'
    const credit = await store.credit(first.player.player_id, 10, 'smoke', 'tx-smoke')
    const repeatedCredit = await store.credit(first.player.player_id, 10, 'smoke', 'tx-smoke')
    if (credit.balance !== 10 || repeatedCredit.balance !== 10 || repeatedCredit.applied !== false) {
      throw new Error('credit retry did not return balance 10 with applied false')
    }
    console.log('wallet: ok')

    step = 'elo'
    const a = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'smoke-elo-a' })
    const b = await store.getOrCreateByIdentity({ provider: 'guest', external_id: 'smoke-elo-b' })
    const result = await store.applyRankedResult({
      match_id: 'm-smoke', game: 'smoke', a: a.player.player_id, b: b.player.player_id, score_a: 1,
    })
    if (result.a.after !== 2580 || result.b.after !== 2420) throw new Error(`unexpected ratings ${result.a.after}/${result.b.after}`)
    console.log('elo: ok')
  } catch (error) {
    console.error(`${step}: FAIL ${error instanceof Error ? error.message : String(error)}`)
    try { client?.close() } catch { /* Best-effort cleanup. */ }
    try { await srv?.close() } catch { /* Preserve the original failure. */ }
    process.exit(1)
  }

  process.exit(0)
}

void main()
