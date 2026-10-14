// RS256 JWT verification against a JWKS, with node:crypto only (no dependency).
// Fail closed: any malformed token, unknown algorithm, unknown key, bad signature or failed claim check throws.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

export class JwtError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`jwt: ${code}`)
    this.name = 'JwtError'
    this.code = code
  }
}

export interface Jwks {
  /** The key of `kid`; refetches the set once when the kid is unknown (rate limited). Null when it does not exist. */
  keyFor(kid: string): Promise<KeyObject | null>
}

export function createJwks(url: string, opts: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; minRefreshMs?: number } = {}): Jwks {
  const f = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? 3_600_000
  const minRefresh = opts.minRefreshMs ?? 30_000
  let keys = new Map<string, KeyObject>()
  let fetchedAt = -Infinity
  let inflight: Promise<void> | null = null

  async function load(): Promise<void> {
    const res = await f(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new JwtError('jwks_unavailable')
    const body = (await res.json()) as { keys?: Array<Record<string, unknown>> }
    const next = new Map<string, KeyObject>()
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue
      if (jwk.use !== undefined && jwk.use !== 'sig') continue
      try { next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' })) } catch { /* skip an unusable key */ }
    }
    if (next.size === 0) throw new JwtError('jwks_empty')
    keys = next
    fetchedAt = now()
  }
  function refresh(): Promise<void> {
    inflight ??= load().finally(() => { inflight = null })
    return inflight
  }
  return {
    async keyFor(kid) {
      const age = now() - fetchedAt
      if (age > ttl) { try { await refresh() } catch (e) { if (keys.size === 0) throw e } }
      let key = keys.get(kid)
      if (!key && now() - fetchedAt >= minRefresh) {
        try { await refresh() } catch (e) { if (keys.size === 0) throw e }
        key = keys.get(kid)
      }
      return key ?? null
    },
  }
}

export interface JwtChecks {
  iss: string
  /** The accepted audiences (any one of them). */
  aud: string[]
  /** Required `typ` header value, or null for no requirement. */
  typ: string | null
  now: number
  /** Clock skew tolerated on exp / nbf, seconds. */
  skewSec?: number
}

export interface Verified { header: Record<string, unknown>; payload: Record<string, unknown> }

function b64json(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
  } catch { /* fall through */ }
  throw new JwtError('malformed')
}

/** Reads the payload WITHOUT verifying it: only to pick which configuration to verify against. Never trust it. */
export function unverifiedPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('malformed')
  return b64json(parts[1]!)
}

export async function verifyJwt(token: string, jwks: Jwks, checks: JwtChecks): Promise<Verified> {
  if (typeof token !== 'string' || token.length > 8192) throw new JwtError('malformed')
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some(p => p === '' || !/^[A-Za-z0-9_-]+$/.test(p))) throw new JwtError('malformed')
  const header = b64json(parts[0]!)
  if (header.alg !== 'RS256') throw new JwtError('bad_alg')
  if (typeof header.kid !== 'string') throw new JwtError('no_kid')
  if (checks.typ !== null && header.typ !== checks.typ) throw new JwtError('bad_typ')
  const key = await jwks.keyFor(header.kid)
  if (!key) throw new JwtError('unknown_key')
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))
  if (!ok) throw new JwtError('bad_signature')
  const payload = b64json(parts[1]!)
  if (payload.iss !== checks.iss) throw new JwtError('bad_iss')
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!aud.some(a => typeof a === 'string' && checks.aud.includes(a))) throw new JwtError('bad_aud')
  const skew = checks.skewSec ?? 30
  const nowSec = Math.floor(checks.now / 1000)
  if (payload.exp !== undefined && (typeof payload.exp !== 'number' || payload.exp + skew < nowSec)) throw new JwtError('expired')
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - skew > nowSec)) throw new JwtError('not_yet_valid')
  return { header, payload }
}
