// Entry point: load config from the environment, start the server, close gracefully on signals.

import { loadConfig } from './config.ts'
import { startServer } from './server.ts'

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)
  const srv = await startServer(cfg)
  console.log(`rooms listening on ${cfg.host}:${srv.port}`)
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    try {
      await srv.close()
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
