// Composition of the player stores from a StoreConfig (used by main.ts, testable with a fake fetch).

import { createMemoryStore } from './memory.ts'
import { createGameRouter, singleStoreRouter } from './games.ts'
import type { GameRouter } from './games.ts'
import { createCrmTableApi } from './tables.ts'
import type { StoreConfig } from './config.ts'

export async function openStores(cfg: StoreConfig, opts: {
  log?: (level: string, msg: string) => void
  fetch?: typeof fetch
  intervalMs?: number
} = {}): Promise<GameRouter & { close(): void }> {
  if (cfg.mode === 'memory') return { ...singleStoreRouter(createMemoryStore()), close() {} }
  const apis = Object.fromEntries(Object.entries(cfg.games).map(([game, apiKey]) =>
    [game, createCrmTableApi({ baseUrl: cfg.baseUrl, apiKey, fetch: opts.fetch })]))
  return createGameRouter(apis, { log: opts.log, intervalMs: opts.intervalMs })
}
