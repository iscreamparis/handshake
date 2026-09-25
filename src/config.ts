// Server configuration from environment variables.

export interface Config {
  port: number
  host: string
  stunUrls: string[]
  turnUrls: string[]
  turnSecret: string | null
  maxRooms: number
  maxClients: number
  allowedOrigins: string[]
  logLevel: 'error' | 'info' | 'debug'
}

function list(v: string | undefined, def: string): string[] {
  return (v ?? def).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

function int(env: Record<string, string | undefined>, name: string, def: number): number {
  const v = env[name]
  if (v === undefined) return def
  const s = v.trim()
  if (!/^\d+$/.test(s)) throw new Error(`[config] ${name}`)
  const n = Number(s)
  if (!Number.isSafeInteger(n)) throw new Error(`[config] ${name}`)
  return n
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const logLevel = env.LOG_LEVEL ?? 'info'
  if (logLevel !== 'error' && logLevel !== 'info' && logLevel !== 'debug') throw new Error('[config] LOG_LEVEL')
  const turnSecret = env.TURN_SECRET
  return {
    port: int(env, 'PORT', 8787),
    host: env.HOST ?? '127.0.0.1',
    stunUrls: list(env.STUN_URLS, 'stun:stun.l.google.com:19302'),
    turnUrls: list(env.TURN_URLS, ''),
    turnSecret: turnSecret === undefined || turnSecret === '' ? null : turnSecret,
    maxRooms: int(env, 'MAX_ROOMS', 500),
    maxClients: int(env, 'MAX_CLIENTS', 2000),
    allowedOrigins: list(env.ALLOWED_ORIGINS, ''),
    logLevel,
  }
}
