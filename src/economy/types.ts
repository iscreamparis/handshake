// Economy types. Nothing here names a game: the card pool, the pack rules and the rewards come from the
// mission's data (etc_settings key `economy.catalog`), the prices and what a purchase grants from etc_products.

export type ProductProvider = 'wavedash' | 'stripe' | 'coins'

/** A row of etc_products (catalogue edited in the backoffice). */
export interface Product {
  provider: ProductProvider
  /** Wavedash consumable id, Stripe product code or coin-shop code (unique per provider). */
  code: string
  label: string
  /** Minor units for money (cents), coins for provider `coins`. */
  price: number
  currency: string
  grant_coins: number
  /** pack_type -> count */
  grant_packs: Record<string, number>
  active: boolean
}

export interface CardDef { id: string; rarity: string; token?: boolean }

/** `random`: tiered draw of `size` cards (rules below). `fixed`: exactly these cards (story rewards). */
export interface PackDef {
  kind: 'random' | 'fixed'
  size: number
  /** Ordered tiers, lowest first. */
  tiers: string[]
  /** tier -> weight */
  weights: Record<string, number>
  /** rarity -> tier (a rarity not listed is its own tier name) */
  tier_of: Record<string, string>
  /** When no card above the first tier was drawn, the last slot is drawn from `min_tier` upwards. */
  guarantee: { slot: 'last'; min_tier: string } | null
  /** Coins refunded per duplicate card (already owned, or repeated in the pack). */
  duplicate_refund: number
  /** kind `fixed` only. */
  cards: string[]
}

export interface RewardDef { coins: number; packs: Record<string, number> }

export interface Catalog {
  cards: CardDef[]
  packs: Record<string, PackDef>
  /** reward id (exact, or prefix ending with `*`) -> what it grants (once per player and id). */
  rewards: Record<string, RewardDef>
}

export const EMPTY_CATALOG: Catalog = { cards: [], packs: {}, rewards: {} }

/** Net change of one operation on a player's state. Cards are never removed (a refund keeps what was opened). */
export interface Fx {
  coins: number
  packs: Record<string, number>
  cards: Record<string, number>
}

export interface DrawnCard { id: string; rarity: string; is_new: boolean; duplicate: boolean }

export interface EconomyState {
  coins: number
  version: number
  packs: Record<string, number>
  cards: Record<string, number>
}

export interface OpResult<R> { result: R; applied: boolean }

export interface OpenResult { pack_type: string; cards: DrawnCard[]; refund: number; coins: number; remaining: number }
export interface BuyResult { product: string; qty: number; coins: number; packs: Record<string, number> }
export interface RewardResult { reward_id: string; granted: RewardDef; coins: number }
export interface PurchaseResult { provider: ProductProvider; external_id: string; product: string; status: 'granted' | 'refunded'; coins: number; granted: { coins: number; packs: Record<string, number> } }
