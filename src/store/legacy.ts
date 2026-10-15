/** Owner games predate creator quotas and keep their established limits. */
export const isLegacyGame = (game: string): boolean => game === 'kekkai' || game === 'monsterracer'
