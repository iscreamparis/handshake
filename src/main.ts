// Entry point: load config from the environment, start the server, close gracefully on signals.

import { loadConfig } from './config.ts'
import { createHandshake } from './handshake.ts'
import { defaultDeps } from './server.ts'
import { verifyIdentityHook } from './identity.ts'
import { loadStoreConfig } from './store/config.ts'
import { openStores } from './store/setup.ts'

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)
  const storeCfg = loadStoreConfig(process.env) // throws a clear [config] error, never printing a key
  const log = defaultDeps(cfg).log
  const stores = await openStores(storeCfg, { log })
  if (storeCfg.mode === 'http') console.log(`player store: http, games: ${Object.keys(storeCfg.games).join(', ')}`)
  else console.log('player store: memory')
  const hs = createHandshake({
    config: cfg,
    store: stores,
    hooks: {
      // guest is verified; wavedash and itch refuse until real verifiers are injected (src/identity.ts).
      verifyIdentity: verifyIdentityHook(),
      // No pickResident: residents are a separate service that embeds Handshake (no resident is invented here).
      onMatchEnd: (r) => log('info', `[match] end ${r.game}/${r.queue} ${r.match_id} ${r.status}`),
    },
  })
  const { port } = await hs.listen()
  console.log(`rooms listening on ${cfg.host}:${port}`)
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    try {
      await hs.close()
      stores.close()
    } catch (e) {
      console.error(e)
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'startup failed')
  process.exit(1)
})
