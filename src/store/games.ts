// One PlayerStore per game. A game is a CRM mission: its own players, ratings and settings,
// reached through its own service key. The router chooses the store from the `game` of the message.

import { createHttpPlayerStore } from './http.ts'
import { createGameSettings, DEFAULT_GAME_PARAMS } from './gamesettings.ts'
import type { GameSettings } from './gamesettings.ts'
import type { TableApi } from './tables.ts'
import type { PlayerStore, QueueName } from './types.ts'

export interface GameBackend {
  /** Null for the legacy single shared store (any game name is accepted). */
  game: string | null
  store: PlayerStore
  queues(): readonly QueueName[]
}

export interface GameRouter {
  /** The backend of a game, or null when the game is unknown. With exactly one game configured, `undefined` selects it. */
  resolve(game: string | undefined): GameBackend | null
}

/** One store for every game name (memory store, tests, embedding): the behaviour before multi-game support. */
export function singleStoreRouter(store: PlayerStore): GameRouter {
  const backend: GameBackend = { game: null, store, queues: () => DEFAULT_GAME_PARAMS.queues }
  return { resolve: () => backend }
}

export interface GameRouterHandle extends GameRouter {
  readonly games: string[]
  close(): void
}

/**
 * Builds the router from `{ game: TableApi }` (one tenant table client per game, each with that game's key).
 * Reads every game's etc_game once (a game whose key points to another mission is refused), then refreshes it on a timer.
 */
export async function createGameRouter(apis: Record<string, TableApi>, opts: {
  intervalMs?: number
  now?: () => number
  log?: (level: string, msg: string) => void
} = {}): Promise<GameRouterHandle> {
  const backends = new Map<string, GameBackend>()
  const settings: GameSettings[] = []
  for (const [game, api] of Object.entries(apis)) {
    const s = createGameSettings(api, { game, intervalMs: opts.intervalMs, log: opts.log })
    if ((await s.refresh()) === 'mismatch') throw new Error(`[config] game "${game}": its service key reads a mission whose etc_game.handshake_game is another game`)
    settings.push(s)
    backends.set(game, {
      game,
      store: createHttpPlayerStore(api, { now: opts.now, elo: () => s.current().elo }),
      queues: () => s.current().queues,
    })
  }
  for (const s of settings) s.start()
  return {
    games: [...backends.keys()],
    resolve(game) {
      if (game === undefined) return backends.size === 1 ? [...backends.values()][0]! : null
      return backends.get(game) ?? null
    },
    close() { for (const s of settings) s.stop() },
  }
}
