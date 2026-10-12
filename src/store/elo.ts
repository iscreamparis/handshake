import type { TierName } from './types.ts'

export const START_RATING = 2500
export const PLACEMENT_GAMES = 5

export function expectedScore(r: number, rOpp: number): number {
  return 1 / (1 + 10 ** ((rOpp - r) / 400))
}

export function kFactor(gamesBefore: number): number {
  return gamesBefore < 5 ? 160 : Math.max(32, 160 - 16 * gamesBefore)
}

export function nextRating(r: number, rOpp: number, score: 0 | 0.5 | 1, gamesBefore: number): number {
  return Math.max(0, Math.round(r + kFactor(gamesBefore) * (score - expectedScore(r, rOpp))))
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
