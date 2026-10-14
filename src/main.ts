// Entry point: load config from the environment, start the server, close gracefully on signals.

import { loadConfig } from './config.ts'
import { createHandshake } from './handshake.ts'
import { defaultDeps } from './server.ts'
import { defaultVerifiers, verifyIdentityHook } from './identity.ts'
import { loadStoreConfig } from './store/config.ts'
import { openStores } from './store/setup.ts'
import { createWavedash } from './economy/wavedash.ts'
import { economyRoutes } from './economy/routes.ts'

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)
  const storeCfg = loadStoreConfig(process.env) // throws a clear [config] error, never printing a key
  const log = defaultDeps(cfg).log
  const wavedash = createWavedash()
  const stores = await openStores(storeCfg, { log, wavedash })
  if (storeCfg.mode === 'http') console.log(`player store: http, games: ${Object.keys(storeCfg.games).join(', ')}`)
  else console.log('player store: memory')
  const hs = createHandshake({
    config: cfg,
    store: stores,
    hooks: {
      // guest and wavedash (user JWT against the Wavedash JWKS) are verified; itch refuses until a real verifier is injected (src/identity.ts).
      verifyIdentity: verifyIdentityHook(defaultVerifiers({ wavedash: wavedash.identityVerifier() })),
      // No pickResident: residents are a separate service that embeds Handshake (no resident is invented here).
      onMatchEnd: (r) => log('info', `[match] end ${r.game}/${r.queue} ${r.match_id} ${r.status}`),
    },
    // Payment webhooks: /webhooks/wavedash and /webhooks/stripe.
    http: economyRoutes({ backends: () => stores.backends(), log }),
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
