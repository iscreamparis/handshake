// Pack opening, server side. This is a port of the draw rules of Kekkai's `src/economy/packs.ts` (tiered
// weights, a guaranteed non-base last slot, one retry loop against repeats, tier-sorted reveal), with every
// value (pack size, tiers, weights, guarantee, refund) taken from the PackDef of the catalog instead of
// constants. The randomness is the server's: `rng` is a crypto-backed [0,1) by default, injectable in tests.

import { randomBytes } from 'node:crypto'
import type { CardDef, DrawnCard, PackDef } from './types.ts'

export type Rng = () => number

/** Uniform [0,1) from 6 random bytes (48 bits, exact in a double). */
export const cryptoRng: Rng = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48

export function tierOf(def: PackDef, rarity: string): string {
  return def.tier_of[rarity] ?? rarity
}

function pickOne<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

/** Draws the cards of a `random` pack. `pool` is the catalog without tokens; `owned` the card ids the player holds. */
export function drawRandom(def: PackDef, rng: Rng, pool: readonly CardDef[], owned: ReadonlySet<string>): DrawnCard[] {
  if (pool.length === 0) return []
  const tiers = def.tiers
  const buckets = tiers.map(t => pool.filter(c => tierOf(def, c.rarity) === t))
  const known = pool.filter(c => tiers.includes(tierOf(def, c.rarity)))
  if (known.length === 0) return []
  const seen = new Set<string>()
  const out: Array<DrawnCard & { rank: number }> = []
  let hasAbove = false
  const guaranteeFrom = def.guarantee ? tiers.indexOf(def.guarantee.min_tier) : 0
  for (let slot = 0; slot < def.size; slot++) {
    const firstTier: number = def.guarantee && slot === def.size - 1 && !hasAbove ? guaranteeFrom : 0
    const total = tiers.slice(firstTier).reduce((sum, t) => sum + (def.weights[t] ?? 0), 0)
    let roll = rng() * total
    let rank: number = firstTier
    while (rank < tiers.length - 1 && roll >= (def.weights[tiers[rank]!] ?? 0)) roll -= def.weights[tiers[rank++]!] ?? 0
    while (rank > 0 && buckets[rank]!.length === 0) rank--
    while (buckets[rank]!.length === 0) rank++
    const bucket = buckets[rank]!
    let card = pickOne(rng, bucket)
    for (let retry = 0; retry < 8 && seen.has(card.id); retry++) card = pickOne(rng, bucket)
    const isNew = !owned.has(card.id) && !seen.has(card.id)
    out.push({ id: card.id, rarity: card.rarity, is_new: isNew, duplicate: !isNew, rank })
    seen.add(card.id)
    hasAbove ||= rank > 0
  }
  // Stable sort: equal tiers keep the slot order.
  return out.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...c }) => c)
}

/** The cards of a `fixed` pack, in the order of its list (that order is the reveal order). */
export function fixedCards(def: PackDef, byId: ReadonlyMap<string, CardDef>, owned: ReadonlySet<string>): DrawnCard[] {
  const seen = new Set<string>()
  const out: DrawnCard[] = []
  for (const id of def.cards) {
    const card = byId.get(id)
    // A card removed from the catalog since the pack was granted is skipped.
    if (!card) continue
    const isNew = !owned.has(id) && !seen.has(id)
    out.push({ id, rarity: card.rarity, is_new: isNew, duplicate: !isNew })
    seen.add(id)
  }
  return out
}
