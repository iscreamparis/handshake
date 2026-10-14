// Per-game parameters read from the mission's single `etc_game` row: Elo start / K floor,
// placement games and the allowed queues. Read at start-up, refreshed on a timer, and the
// previous (or default) values are kept whenever a read or a row is invalid.

import { DEFAULT_ELO } from './elo.ts'
import type { EloParams } from './elo.ts'
import type { Row, TableApi } from './tables.ts'
import type { QueueName } from './types.ts'

export interface GameParams { elo: EloParams; queues: readonly QueueName[] }

export const DEFAULT_GAME_PARAMS: GameParams = { elo: DEFAULT_ELO, queues: ['quick', 'ranked'] }

export const REFRESH_MS = 60_000

function int(v: unknown, min: number, max: number, name: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`etc_game.${name} must be an integer in ${min}..${max}`)
  return n
}

/** Validates an etc_game row; throws a message that never contains row data. */
export function parseGameRow(row: Row): GameParams {
  const elo: EloParams = {
    start: int(row.elo_start, 0, 100_000, 'elo_start'),
    kFloor: int(row.elo_k_floor, 1, 160, 'elo_k_floor'),
    placementGames: int(row.placement_games, 0, 100, 'placement_games'),
  }
  let q: unknown = row.queues
  if (typeof q === 'string') {
    try { q = JSON.parse(q) } catch { throw new Error('etc_game.queues is not valid JSON') }
  }
  if (!Array.isArray(q) || q.length === 0 || q.some(x => x !== 'quick' && x !== 'ranked')) {
    throw new Error('etc_game.queues must be a non-empty JSON array of "quick" / "ranked"')
  }
  return { elo, queues: [...new Set(q as QueueName[])] }
}

export type RefreshResult = 'ok' | 'no_row' | 'invalid' | 'failed' | 'mismatch'

export interface GameSettings {
  /** Synchronous: the last good parameters (defaults until the first successful read). */
  current(): GameParams
  refresh(): Promise<RefreshResult>
  /** Starts the periodic refresh (unref'd timer). */
  start(): void
  stop(): void
}

export function createGameSettings(api: TableApi, opts: {
  /** The handshake_game this store serves; a row naming another game means the key belongs to the wrong mission. */
  game: string
  intervalMs?: number
  log?: (level: string, msg: string) => void
}): GameSettings {
  let params = DEFAULT_GAME_PARAMS
  let timer: ReturnType<typeof setInterval> | null = null
  const log = opts.log ?? (() => {})
  return {
    current: () => params,
    async refresh() {
      let row: Row | undefined
      try {
        row = (await api.query('etc_game', { size: 1 }))[0]
      } catch {
        log('error', `[games] ${opts.game}: etc_game read failed, keeping current parameters`)
        return 'failed'
      }
      if (!row) {
        log('error', `[games] ${opts.game}: no etc_game row, keeping current parameters`)
        return 'no_row'
      }
      if (typeof row.handshake_game === 'string' && row.handshake_game !== '' && row.handshake_game !== opts.game) {
        log('error', `[games] ${opts.game}: etc_game.handshake_game is "${row.handshake_game}": the service key probably belongs to another mission`)
        return 'mismatch'
      }
      try {
        params = parseGameRow(row)
      } catch (e) {
        log('error', `[games] ${opts.game}: ${(e as Error).message}, keeping current parameters`)
        return 'invalid'
      }
      return 'ok'
    },
    start() {
      if (timer) return
      timer = setInterval(() => { void this.refresh() }, opts.intervalMs ?? REFRESH_MS)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
