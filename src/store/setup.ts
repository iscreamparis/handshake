// Composition of the player stores from a StoreConfig (used by main.ts, testable with a fake fetch).

import { createMemoryStore } from './memory.ts'
import { readFile } from 'node:fs/promises'
import { loadStoreConfig } from './config.ts'
import { createGameRouter, singleStoreRouter } from './games.ts'
import type { GameBackend, GameRouter, GameRouterHandle } from './games.ts'
import { createCrmTableApi, createMemoryTableApi } from './tables.ts'
import type { StoreConfig } from './config.ts'
import { createEconomyService } from '../economy/service.ts'
import { createStripeBridge } from '../economy/stripe.ts'
import type { Wavedash } from '../economy/wavedash.ts'
import { createOnline } from '../online/index.ts'
import { isLegacyGame } from './legacy.ts'

export type OpenedStores = GameRouter & { backends(): GameBackend[]; close(): void }

/** Default period of the ETCITO_GAME_KEYS_FILE re-read. */
export const REGISTRY_REFRESH_MS = 30_000

export async function openStores(cfg: StoreConfig, opts: {
  log?: (level: string, msg: string) => void
  fetch?: typeof fetch
  intervalMs?: number
  /** Period of the key-file re-read (multi-creator mode); default 30 s. */
  registryIntervalMs?: number
  /** Wavedash receipt / user JWT verification (shared by every game). Without it the Wavedash economy path is off. */
  wavedash?: Wavedash
} = {}): Promise<OpenedStores> {
  if (cfg.mode === 'memory') {
    const store = createMemoryStore()
    const api = createMemoryTableApi()
    const economy = createEconomyService({ game: 'memory', api, store, wavedash: opts.wavedash, log: opts.log })
    economy.start()
    const router = singleStoreRouter(store, economy, createOnline(api, { log: opts.log }))
    return { ...router, backends: () => [router.resolve(undefined)!], close() { economy.stop() } }
  }
  const multiCreator = cfg.keyFile !== undefined
  const makeRouter = (games: Record<string, string>): Promise<GameRouterHandle> => {
    const apis = Object.fromEntries(Object.entries(games).map(([game, apiKey]) =>
      [game, createCrmTableApi({ baseUrl: cfg.baseUrl, apiKey, fetch: opts.fetch })]))
    return createGameRouter(apis, {
      log: opts.log,
      intervalMs: opts.intervalMs,
      multiCreator,
      economy: (game, api, store) => createEconomyService({
        game, api, store, wavedash: opts.wavedash, log: opts.log,
        ...(multiCreator && !isLegacyGame(game) ? { maxCatalogBytes: 1024 * 1024 } : {}),
        // The bridge authenticates with the game's own service key: it reads the Stripe keys of the tenant, Handshake never does.
        stripe: createStripeBridge({ baseUrl: cfg.baseUrl, apiKey: games[game]!, fetch: opts.fetch }),
      }),
    })
  }
  // Single-owner mode (no ETCITO_GAME_KEYS_FILE): one router for the games of ETCITO_GAME_KEYS, as before.
  if (!multiCreator) return makeRouter(cfg.games)

  // Multi-creator mode: one router PER GAME, so a registry change only builds the added games, rebuilds a game whose
  // key changed and closes a removed one. A game whose key is unchanged keeps its backend (economy locks, caches,
  // MatchService listeners): onboarding a creator never touches the owner's games.
  const entries = new Map<string, { key: string; router: GameRouterHandle }>()
  for (const [game, key] of Object.entries(cfg.games)) {
    try {
      entries.set(game, { key, router: await makeRouter({ [game]: key }) })
    } catch (e) {
      for (const x of entries.values()) x.router.close()
      throw e
    }
  }
  let busy = false
  let closed = false
  const refresh = async (): Promise<void> => {
    if (busy || closed) return
    busy = true
    try {
      let next: Record<string, string>
      try {
        const raw = await readFile(cfg.keyFile!, 'utf8')
        const parsed = loadStoreConfig({ PLAYER_STORE: 'http', ETCITO_URL: cfg.baseUrl, ETCITO_GAME_KEYS: raw })
        if (parsed.mode !== 'http') return
        next = parsed.games
      } catch {
        // Never forward the message: it may quote the file. The previous registry stays active.
        opts.log?.('error', '[games] ETCITO_GAME_KEYS_FILE unreadable or invalid; keeping the previous games')
        return
      }
      const changed: string[] = []
      for (const [game, key] of Object.entries(next)) {
        const had = entries.get(game)
        if (had && had.key === key) continue
        let router: GameRouterHandle
        try { router = await makeRouter({ [game]: key }) } catch {
          opts.log?.('error', `[games] ${game}: could not be opened; keeping its previous state`)
          continue
        }
        if (closed) { router.close(); return }
        entries.set(game, { key, router })
        had?.router.close()
        changed.push(had ? `${game} (key rotated)` : `${game} (added)`)
      }
      for (const [game, had] of [...entries]) {
        if (Object.hasOwn(next, game)) continue
        entries.delete(game)
        had.router.close()
        changed.push(`${game} (removed)`)
      }
      if (changed.length) opts.log?.('info', `[games] registry reloaded: ${changed.join(', ')}`)
    } finally { busy = false }
  }
  const timer = setInterval(() => { void refresh() }, opts.registryIntervalMs ?? REGISTRY_REFRESH_MS)
  timer.unref()
  const all = (): GameRouterHandle[] => [...entries.values()].map(x => x.router)
  return {
    strictGames: true,
    resolve(game) {
      if (game === undefined) return entries.size === 1 ? all()[0]!.resolve(undefined) : null
      return entries.get(game)?.router.resolve(game) ?? null
    },
    backends: () => all().flatMap(r => r.backends()),
    close() { closed = true; clearInterval(timer); for (const r of all()) r.close() },
  }
}
