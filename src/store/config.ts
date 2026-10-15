// Player store selection from the environment. Nothing is hardcoded: games and keys come from
// ETCITO_GAME_KEYS. Errors name the variable, never its value (the keys are secrets).

import { readFileSync } from 'node:fs'

export type StoreConfig =
  | { mode: 'memory' }
  | { mode: 'http'; baseUrl: string; games: Record<string, string>; keyFile?: string }

function fail(name: string, why: string): never {
  throw new Error(`[config] ${name}: ${why}`)
}

export function loadStoreConfig(env: Record<string, string | undefined>): StoreConfig {
  const mode = (env.PLAYER_STORE ?? 'memory').trim()
  if (mode === 'memory') return { mode }
  if (mode !== 'http') fail('PLAYER_STORE', 'must be "http" or "memory"')

  const rawUrl = (env.ETCITO_URL ?? '').trim()
  if (rawUrl === '') fail('ETCITO_URL', 'required when PLAYER_STORE=http')
  let url: URL
  try { url = new URL(rawUrl) } catch { fail('ETCITO_URL', 'not a valid URL') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('ETCITO_URL', 'must be http(s)')
  if (url.username !== '' || url.password !== '') fail('ETCITO_URL', 'must not embed credentials')

  const keyFile = env.ETCITO_GAME_KEYS_FILE?.trim()
  let rawKeys = env.ETCITO_GAME_KEYS
  if (keyFile) {
    try { rawKeys = readFileSync(keyFile, 'utf8') } catch { fail('ETCITO_GAME_KEYS_FILE', 'unreadable') }
  }
  if (rawKeys === undefined || rawKeys.trim() === '') fail('ETCITO_GAME_KEYS', 'required when PLAYER_STORE=http (JSON object {"<game>":"gsk_..."})')
  let parsed: unknown
  // JSON.parse messages quote the input: never forward them.
  try { parsed = JSON.parse(rawKeys) } catch { fail('ETCITO_GAME_KEYS', 'not valid JSON') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('ETCITO_GAME_KEYS', 'must be a JSON object {"<game>":"gsk_..."}')
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) fail('ETCITO_GAME_KEYS', 'no game configured')
  const games: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [game, key] of entries) {
    if (game.length < 1 || game.length > 64) fail('ETCITO_GAME_KEYS', 'a game name must be 1..64 chars')
    if (typeof key !== 'string' || !/^gsk_\S+$/.test(key)) fail('ETCITO_GAME_KEYS', `the key of game "${game}" must be a string starting with gsk_`)
    // Two games on one key would read the same mission: a key is the identity of one game.
    if (seen.has(key)) fail('ETCITO_GAME_KEYS', `game "${game}" reuses the key of another game (one service key per game)`)
    seen.add(key)
    games[game] = key
  }
  return { mode: 'http', baseUrl: rawUrl, games, ...(keyFile ? { keyFile } : {}) }
}
