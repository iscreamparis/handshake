// One PlayerStore per game. A game is a CRM mission: its own players, ratings and settings,
// reached through its own service key. The router chooses the store from the `game` of the message.

import { createHttpPlayerStore } from './http.ts'
import { createGameSettings, DEFAULT_CREATOR_MAX_ROOMS, DEFAULT_GAME_PARAMS } from './gamesettings.ts'
import type { OnlineLimits } from '../online/limits.ts'
import type { GameSettings } from './gamesettings.ts'
import type { TableApi } from './tables.ts'
import type { PlayerStore, QueueName } from './types.ts'
import type { EconomyService } from '../economy/service.ts'
import { createOnline } from '../online/index.ts'
import { isLegacyGame } from './legacy.ts'
import type { OnlineServices } from '../online/index.ts'

export interface GameBackend {
  /** Null for the legacy single shared store (any game name is accepted). */
  game: string | null
  store: PlayerStore
  queues(): readonly QueueName[]
  maxRooms?(): number | undefined
  /** The economy of the game (wallet, packs, cards, purchases); absent when none is configured. */
  economy?: EconomyService
  /** Cloud saves, stats + achievements and player content of the game. */
  online?: OnlineServices
}

export interface GameRouter {
  /** The backend of a game, or null when the game is unknown. With exactly one game configured, `undefined` selects it. */
  resolve(game: string | undefined): GameBackend | null
  /** Multi-creator mode: an unknown game is refused at hello (rooms included). Absent/false = any game name opens rooms, as before. */
  readonly strictGames?: boolean
}

/** One store for every game name (memory store, tests, embedding): the behaviour before multi-game support. */
export function singleStoreRouter(store: PlayerStore, economy?: EconomyService, online?: OnlineServices): GameRouter {
  const backend: GameBackend = { game: null, store, queues: () => DEFAULT_GAME_PARAMS.queues, ...(economy ? { economy } : {}), ...(online ? { online } : {}) }
  return { resolve: () => backend }
}

export interface GameRouterHandle extends GameRouter {
  readonly games: string[]
  /** Every game's backend (the HTTP webhooks look games up by receipt / event). */
  backends(): GameBackend[]
  close(): void
}

/** Platform ceilings of a creator game (multi-creator mode). Env: ETCITO_CREATOR_STORAGE_MAX_BYTES, ETCITO_CREATOR_MAX_ROOMS. */
export function creatorCaps(env: Record<string, string | undefined> = process.env): { maxRooms: number; online: Partial<OnlineLimits> } {
  const pos = (v: string | undefined, def: number): number => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isSafeInteger(n) && n > 0 ? n : def }
  const total = pos(env.ETCITO_CREATOR_STORAGE_MAX_BYTES, 50 * 1024 * 1024)
  return {
    maxRooms: pos(env.ETCITO_CREATOR_MAX_ROOMS, DEFAULT_CREATOR_MAX_ROOMS),
    online: {
      savesMaxBytes: 196_608, savesQuotaBytes: Math.floor(total / 5), savesMaxKeys: 32, savesWritesPerMinute: 60,
      ugcMaxBytes: 196_608, ugcQuotaBytes: total - Math.floor(total / 5), ugcMaxItems: 100, ugcWritesPerMinute: 30,
    },
  }
}

/**
 * Builds the router from `{ game: TableApi }` (one tenant table client per game, each with that game's key).
 * Reads every game's etc_game once (a game whose key points to another mission is refused), then refreshes it on a timer.
 */
export async function createGameRouter(apis: Record<string, TableApi>, opts: {
  intervalMs?: number
  now?: () => number
  log?: (level: string, msg: string) => void
  /** Builds the economy of a game from its table client and player store. */
  economy?: (game: string, api: TableApi, store: PlayerStore) => EconomyService | undefined
  /**
   * Multi-creator mode (ETCITO_GAME_KEYS_FILE). Off (default) = exactly the single-owner behaviour: a mismatched key
   * aborts the start-up, no per-game caps. On: a mismatch disables that game alone, and every game that is not an
   * owner game (isLegacyGame) is a creator game with capped rooms, saves, UGC and a strict handshake_game.
   */
  multiCreator?: boolean
} = {}): Promise<GameRouterHandle> {
  const backends = new Map<string, GameBackend>()
  const settings: GameSettings[] = []
  const enabled = new Map<string, GameSettings>()
  const caps = opts.multiCreator ? creatorCaps() : undefined
  for (const [game, api] of Object.entries(apis)) {
    const creator = !!caps && !isLegacyGame(game)
    const s = createGameSettings(api, { game, intervalMs: opts.intervalMs, log: opts.log,
      disableOnMismatch: opts.multiCreator, creator, maxRoomsCeiling: caps?.maxRooms })
    const first = await s.refresh()
    if (first === 'mismatch' && !opts.multiCreator) {
      for (const done of settings) done.stop()
      throw new Error(`[config] game "${game}": its service key reads a mission whose etc_game.handshake_game is another game`)
    }
    settings.push(s)
    enabled.set(game, s)
    const store = createHttpPlayerStore(api, { now: opts.now, elo: () => s.current().elo })
    const economy = opts.economy?.(game, api, store)
    const online = createOnline(api, { now: opts.now, log: opts.log, ...(creator && caps ? { limitCaps: caps.online } : {}) })
    backends.set(game, { game, store, queues: () => s.current().queues, ...(creator ? { maxRooms: () => s.maxRooms() } : {}), ...(economy ? { economy } : {}), online })
  }
  for (const s of settings) s.start()
  for (const b of backends.values()) b.economy?.start()
  const isActive = (b: GameBackend): boolean => b.game !== null && enabled.get(b.game)?.active() === true
  return {
    games: [...backends.keys()],
    backends: () => [...backends.values()].filter(isActive),
    resolve(game) {
      if (game === undefined) return backends.size === 1 ? [...backends.values()].find(isActive) ?? null : null
      const b = backends.get(game)
      return b && isActive(b) ? b : null
    },
    close() { for (const s of settings) s.stop(); for (const b of backends.values()) b.economy?.stop() },
  }
}
