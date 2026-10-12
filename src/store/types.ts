export type Provider = 'wavedash' | 'itch' | 'guest'
export type QueueName = 'quick' | 'ranked'
export type PlayerKind = 'human' | 'resident'
export type TierName = 'Bronze' | 'Gold' | 'Platinum' | 'Diamond' | 'Master'
export interface Identity { provider: Provider; external_id: string }
export interface Player { player_id: string; display_name: string; kind: PlayerKind; identities: Identity[]; active_ranked_match: string | null; created_at: number }
export interface Rating { game: string; rating: number; games: number; placement: boolean }
export interface RankedOutcome { match_id: string; game: string; a: string; b: string; score_a: 0 | 0.5 | 1 }
export interface RatingChange { player_id: string; before: number; after: number; games: number; placement: boolean }
export interface RankedResult { match_id: string; game: string; applied: boolean; a: RatingChange; b: RatingChange }
export interface WalletResult { balance: number; applied: boolean }
export interface PacksResult { unopened: number; applied: boolean }
export interface OpenPackResult { cards: string[]; remaining: number; applied: boolean }
export type PackRoller = (playerId: string, game: string) => string[] | Promise<string[]>
export interface LeaderboardEntry { rank: number; player_id: string; display_name: string; rating: number; games: number; tier: TierName }
export interface LeaderboardPage { game: string; page: number; page_size: number; total: number; entries: LeaderboardEntry[] }
export interface PlayerStore {
  getOrCreateByIdentity(identity: Identity, init?: { display_name?: string; kind?: PlayerKind }): Promise<{ player: Player; created: boolean }>
  getPlayer(playerId: string): Promise<Player | null>
  getRating(playerId: string, game: string): Promise<Rating>
  applyRankedResult(outcome: RankedOutcome): Promise<RankedResult>
  lockRanked(playerId: string, matchId: string): Promise<boolean>
  unlockRanked(playerId: string, matchId: string): Promise<boolean>
  balance(playerId: string): Promise<number>
  credit(playerId: string, amount: number, reason: string, txId: string): Promise<WalletResult>
  debit(playerId: string, amount: number, reason: string, txId: string): Promise<WalletResult>
  unopenedPacks(playerId: string, game: string): Promise<number>
  addPacks(playerId: string, game: string, count: number, reason: string, txId: string): Promise<PacksResult>
  openPack(playerId: string, game: string, roller: PackRoller, txId: string): Promise<OpenPackResult>
  collection(playerId: string, game: string): Promise<Record<string, number>>
  leaderboard(game: string, page: number): Promise<LeaderboardPage>
}
