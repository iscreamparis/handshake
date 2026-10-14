// Composition of the player stores from a StoreConfig (used by main.ts, testable with a fake fetch).

import { createMemoryStore } from './memory.ts'
import { createGameRouter, singleStoreRouter } from './games.ts'
import type { GameBackend, GameRouter } from './games.ts'
import { createCrmTableApi, createMemoryTableApi } from './tables.ts'
import type { StoreConfig } from './config.ts'
import { createEconomyService } from '../economy/service.ts'
import { createStripeBridge } from '../economy/stripe.ts'
import type { Wavedash } from '../economy/wavedash.ts'

export type OpenedStores = GameRouter & { backends(): GameBackend[]; close(): void }

export async function openStores(cfg: StoreConfig, opts: {
  log?: (level: string, msg: string) => void
  fetch?: typeof fetch
  intervalMs?: number
  /** Wavedash receipt / user JWT verification (shared by every game). Without it the Wavedash economy path is off. */
  wavedash?: Wavedash
} = {}): Promise<OpenedStores> {
  if (cfg.mode === 'memory') {
    const store = createMemoryStore()
    const economy = createEconomyService({ game: 'memory', api: createMemoryTableApi(), store, wavedash: opts.wavedash, log: opts.log })
    economy.start()
    const router = singleStoreRouter(store, economy)
    return { ...router, backends: () => [router.resolve(undefined)!], close() { economy.stop() } }
  }
  const apis = Object.fromEntries(Object.entries(cfg.games).map(([game, apiKey]) =>
    [game, createCrmTableApi({ baseUrl: cfg.baseUrl, apiKey, fetch: opts.fetch })]))
  return createGameRouter(apis, {
    log: opts.log,
    intervalMs: opts.intervalMs,
    economy: (game, api, store) => createEconomyService({
      game, api, store, wavedash: opts.wavedash, log: opts.log,
      // The bridge authenticates with the game's own service key: it reads the Stripe keys of the tenant, Handshake never does.
      stripe: createStripeBridge({ baseUrl: cfg.baseUrl, apiKey: cfg.games[game]!, fetch: opts.fetch }),
    }),
  })
}
