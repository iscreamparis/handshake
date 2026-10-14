import type { TierName } from './types.ts'

export const START_RATING = 2500
export const PLACEMENT_GAMES = 5
export const K_FLOOR = 32

/** Per-game rating parameters (etc_game: elo_start, elo_k_floor, placement_games). The constants above are the defaults. */
export interface EloParams { start: number; kFloor: number; placementGames: number }
export const DEFAULT_ELO: EloParams = { start: START_RATING, kFloor: K_FLOOR, placementGames: PLACEMENT_GAMES }

export function expectedScore(r: number, rOpp: number): number {
  return 1 / (1 + 10 ** ((rOpp - r) / 400))
}

export function kFactor(gamesBefore: number, params: EloParams = DEFAULT_ELO): number {
  return gamesBefore < params.placementGames ? 160 : Math.max(params.kFloor, 160 - 16 * gamesBefore)
}

export function nextRating(r: number, rOpp: number, score: 0 | 0.5 | 1, gamesBefore: number, params: EloParams = DEFAULT_ELO): number {
  return Math.max(0, Math.round(r + kFactor(gamesBefore, params) * (score - expectedScore(r, rOpp))))
}

export const TIERS: readonly { name: TierName; min: number }[] = [
  { name: 'Bronze', min: 0 },
  { name: 'Gold', min: 1600 },
  { name: 'Platinum', min: 2200 },
  { name: 'Diamond', min: 2800 },
  { name: 'Master', min: 3400 },
]

export function tierOf(rating: number): TierName {
  let tier: TierName = 'Bronze'
  for (const candidate of TIERS) {
    if (candidate.min > rating) break
    tier = candidate.name
  }
  return tier
}

export function displayRating(rating: number, placement: boolean): string | null {
  if (placement) return null
  if (rating < 500) return '< 500'
  return String(rating)
}
