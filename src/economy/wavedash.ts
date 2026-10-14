// Wavedash: user JWT (identity) and purchase receipt verification, and the fulfill call.
// Documented at docs.wavedash.com (sdk/paid-content/consumables, sdk/players, api/webhooks, api/purchases).
//   user JWT   : RS256, JWKS https://auth.wavedash.com/.well-known/jwks.json, iss https://auth.wavedash.com,
//                aud gameplay.wavedash.com, claims sub (user id), gcid (game cloud id), exp.
//   receipt    : same keys, header typ `wavedash-purchase+jwt`, iss same, aud = the game id, env PRODUCTION,
//                claims sub, gcid, event (purchase.completed | purchase.refunded), purchaseId, ptype, contentIdentifier.
// Every check fails closed.

import type { IdentityVerifier } from '../identity.ts'
import { createJwks, JwtError, verifyJwt } from './jwt.ts'
import type { Jwks } from './jwt.ts'

export const WAVEDASH_ISSUER = 'https://auth.wavedash.com'
export const WAVEDASH_JWKS_URL = 'https://auth.wavedash.com/.well-known/jwks.json'
export const WAVEDASH_USER_AUD = 'gameplay.wavedash.com'
export const WAVEDASH_RECEIPT_TYP = 'wavedash-purchase+jwt'
export const WAVEDASH_API = 'https://api.wavedash.com'

export class WavedashError extends Error {
  readonly code: 'bad_receipt' | 'bad_user_jwt' | 'receipt_mismatch' | 'not_production' | 'not_consumable' | 'unknown_game' | 'fulfill_failed'
  constructor(code: WavedashError['code'], detail = '') {
    super(`wavedash: ${code}${detail ? ` (${detail})` : ''}`)
    this.name = 'WavedashError'
    this.code = code
  }
}

export interface UserClaims { sub: string; gcid: string | null }
export interface ReceiptClaims {
  sub: string
  gcid: string | null
  aud: string
  env: string
  event: 'purchase.completed' | 'purchase.refunded'
  purchaseId: string
  ptype: string
  contentIdentifier: string
}

export interface Wavedash {
  verifyUser(token: string): Promise<UserClaims>
  /** `gameIds`: the Wavedash game ids of the game (the receipt audience must be one of them). */
  verifyReceipt(token: string, opts: { gameIds: string[]; allowPlaytest: boolean }): Promise<ReceiptClaims>
  fulfill(purchaseId: string, receiptJwt: string): Promise<'FULFILLED' | 'ALREADY_FULFILLED' | 'NOT_FOUND'>
  identityVerifier(): IdentityVerifier
}

export function createWavedash(opts: { fetch?: typeof fetch; now?: () => number; jwks?: Jwks; jwksUrl?: string; apiBase?: string } = {}): Wavedash {
  const f = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const jwks = opts.jwks ?? createJwks(opts.jwksUrl ?? WAVEDASH_JWKS_URL, { fetch: f, now })
  const api = (opts.apiBase ?? WAVEDASH_API).replace(/\/+$/, '')

  const str = (v: unknown): string | null => typeof v === 'string' && v !== '' && v.length <= 256 ? v : null

  const self: Wavedash = {
    async verifyUser(token) {
      try {
        const { payload } = await verifyJwt(token, jwks, { iss: WAVEDASH_ISSUER, aud: [WAVEDASH_USER_AUD], typ: null, now: now() })
        const sub = str(payload.sub)
        if (!sub) throw new JwtError('no_sub')
        return { sub, gcid: str(payload.gcid) }
      } catch (e) {
        throw new WavedashError('bad_user_jwt', e instanceof JwtError ? e.code : 'error')
      }
    },

    async verifyReceipt(token, o) {
      if (o.gameIds.length === 0) throw new WavedashError('unknown_game', 'no wavedash game id configured')
      let payload: Record<string, unknown>
      try {
        ;({ payload } = await verifyJwt(token, jwks, { iss: WAVEDASH_ISSUER, aud: o.gameIds, typ: WAVEDASH_RECEIPT_TYP, now: now() }))
      } catch (e) {
        throw new WavedashError('bad_receipt', e instanceof JwtError ? e.code : 'error')
      }
      const sub = str(payload.sub), purchaseId = str(payload.purchaseId), contentIdentifier = str(payload.contentIdentifier)
      const aud = Array.isArray(payload.aud) ? str(payload.aud.find(a => o.gameIds.includes(a as string))) : str(payload.aud)
      if (!sub || !purchaseId || !contentIdentifier || !aud) throw new WavedashError('bad_receipt', 'missing claim')
      if (payload.event !== 'purchase.completed' && payload.event !== 'purchase.refunded') throw new WavedashError('bad_receipt', 'event')
      if (payload.env !== 'PRODUCTION' && !(o.allowPlaytest && payload.env === 'PLAYTEST')) throw new WavedashError('not_production')
      if (payload.ptype !== 'CONSUMABLE') throw new WavedashError('not_consumable')
      return {
        sub, gcid: str(payload.gcid), aud, env: payload.env as string, event: payload.event,
        purchaseId, ptype: 'CONSUMABLE', contentIdentifier,
      }
    },

    async fulfill(purchaseId, receiptJwt) {
      let res: Response
      try {
        res = await f(`${api}/api/purchases/${encodeURIComponent(purchaseId)}/fulfill`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receiptJwt }), signal: AbortSignal.timeout(8000),
        })
      } catch {
        throw new WavedashError('fulfill_failed', 'unreachable')
      }
      if (res.status === 404) return 'NOT_FOUND'
      if (!res.ok) throw new WavedashError('fulfill_failed', `HTTP ${res.status}`)
      const body = (await res.json().catch(() => ({}))) as { status?: unknown }
      return body.status === 'ALREADY_FULFILLED' ? 'ALREADY_FULFILLED' : 'FULFILLED'
    },

    identityVerifier() {
      return {
        async verify(token, name) {
          const u = await self.verifyUser(token)
          const display = typeof name === 'string' && name.trim().length >= 3 && name.trim().length <= 16 ? name.trim() : `Player-${u.sub.slice(0, 4)}`
          return { provider: 'wavedash', external_id: u.sub, display_name: display }
        },
      }
    },
  }
  return self
}
