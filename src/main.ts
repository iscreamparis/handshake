// Entry point: load config from the environment, start the server, close gracefully on signals.

import { loadConfig } from './config.ts'
import { createHandshake } from './handshake.ts'
import { createMemoryStore } from './store/memory.ts'

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)
  const hs = createHandshake({ config: cfg, store: createMemoryStore() })
  const { port } = await hs.listen()
  console.log(`rooms listening on ${cfg.host}:${port}`)
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    try {
      await hs.close()
    } catch (e) {
      console.error(e)
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
