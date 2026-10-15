// Payment webhooks. Both are public URLs: nothing in the request is trusted until it is verified
// (Wavedash: the RS256 receipt; Stripe: the signature, checked by the CRM bridge that holds the secret).
// Status codes follow what the senders retry on: a non-2xx is retried (Wavedash: 8 times over 3 days; Stripe: up to 3 days).

import { StoreError } from '../store/errors.ts'
import { isLegacyGame } from '../store/legacy.ts'
import type { GameBackend } from '../store/games.ts'
import type { HttpRoute } from '../transport.ts'
import { unverifiedPayload } from './jwt.ts'
import type { EconomyService } from './service.ts'
import { EconomyUnavailable } from './service.ts'
import { StripeBridgeError } from './stripe.ts'
import { WavedashError } from './wavedash.ts'

type Reply = { status: number; body?: unknown }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function economyRoutes(opts: { backends: () => GameBackend[]; log?: (level: string, msg: string) => void }): HttpRoute[] {
  const log = opts.log ?? (() => {})
  const services = (): EconomyService[] => opts.backends().flatMap(b => (b.economy ? [b.economy] : []))

  const wavedash: HttpRoute = {
    method: 'POST', path: '/webhooks/wavedash', maxBytes: 16384,
    async handle({ body }): Promise<Reply> {
      let receipt: string
      let aud: unknown
      try {
        const parsed = JSON.parse(body) as { receiptJwt?: unknown }
        if (typeof parsed.receiptJwt !== 'string') throw new Error('no receipt')
        receipt = parsed.receiptJwt
        aud = unverifiedPayload(receipt).aud
      } catch {
        return { status: 400, body: { error: 'bad_request' } }
      }
      // The unverified audience only picks WHICH game's configuration the receipt is verified against.
      // Two games claiming one Wavedash id: an owner game wins (a creator copying the owner's id must not block the
      // owner's purchases); otherwise the receipt is refused rather than credited to whichever game comes first.
      const matches: GameBackend[] = []
      for (const b of opts.backends()) {
        if (!b.economy) continue
        const ids = await b.economy.wavedashGameIds().catch(() => [] as string[])
        if (typeof aud === 'string' && ids.includes(aud)) matches.push(b)
      }
      const owners = matches.filter(b => b.game !== null && isLegacyGame(b.game))
      const picked = owners.length ? owners : matches
      if (picked.length !== 1) {
        if (picked.length > 1) log('error', `[webhook] wavedash audience claimed by several games: ${picked.map(b => b.game).join(', ')}`)
        return { status: 400, body: { error: picked.length ? 'ambiguous_game' : 'unknown_game' } }
      }
      const target = picked[0]!.economy!
      try {
        const r = await target.wavedashFromWebhook(receipt)
        return { status: 200, body: { ok: true, status: r.status } }
      } catch (e) {
        if (e instanceof WavedashError) {
          if (e.code === 'fulfill_failed') { log('error', `[webhook] wavedash ${e.message}`); return { status: 502, body: { error: 'fulfill_failed' } } }
          return { status: 400, body: { error: e.code } }
        }
        if (e instanceof StoreError && e.code === 'purchase_refunded') return { status: 200, body: { ok: true, ignored: 'refunded' } }
        if (e instanceof StoreError && e.code === 'unknown_product') {
          log('error', '[webhook] wavedash purchase of a product missing from etc_products: add it, Wavedash will retry')
          return { status: 409, body: { error: 'unknown_product' } }
        }
        log('error', `[webhook] wavedash failed: ${e instanceof Error ? e.name : 'error'}`)
        return { status: 503, body: { error: 'unavailable' } }
      }
    },
  }

  const stripeHandler = (selectedGame?: string): HttpRoute['handle'] =>
    async ({ body, headers }): Promise<Reply> => {
      const selected = selectedGame === undefined ? undefined : opts.backends().find(b => b.game === selectedGame)
      if (selectedGame !== undefined && !selected) return { status: 404, body: { error: 'unknown_game' } }
      if (selectedGame !== undefined && !selected?.economy) return { status: 503, body: { error: 'stripe_not_configured' } }
      return handleStripe(body, headers, selected?.economy, selectedGame)
    }
  const handleStripe = async (body: string, headers: Record<string, string | string[] | undefined>, selectedService?: EconomyService, selectedGame?: string): Promise<Reply> => {
      const sig = headers['stripe-signature']
      if (typeof sig !== 'string' || sig === '') return { status: 400, body: { error: 'no_signature' } }
      // The legacy URL is the owner's Stripe endpoint: verified with the owner games' keys only, never a creator's.
      const owners = opts.backends().filter(b => b.game !== null && isLegacyGame(b.game)).flatMap(b => b.economy ? [b.economy] : [])
      const candidates = selectedService ? [selectedService] : owners.length ? owners : services()
      if (!candidates.length) return { status: 503, body: { error: 'stripe_not_configured' } }
      let event: Record<string, unknown> | null = null
      let failed = false
      for (const verifier of candidates) {
        try { event = await verifier.stripeVerify(body, sig) } catch (e) {
          failed = true
          log('error', `[webhook] stripe verify: ${e instanceof StripeBridgeError || e instanceof EconomyUnavailable ? e.message : 'error'}`)
        }
        if (event) break
      }
      if (!event && failed) return { status: 503, body: { error: 'verification_unavailable' } }
      if (!event) return { status: 400, body: { error: 'bad_signature' } }
      const type = event.type
      const data = event.data
      const obj = isObj(data) && isObj(data.object) ? data.object : null
      if (!obj) {
        log('error', `[webhook] stripe ${String(type)} has no data.object (payload style must be Snapshot, not Thin); keys: ${Object.keys(event).join(',')}`)
        return { status: 200, body: { ok: true, ignored: 'no object' } }
      }
      try {
        if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
          const game = isObj(obj.metadata) && typeof obj.metadata.game === 'string' ? obj.metadata.game : null
          if (selectedGame !== undefined && game !== selectedGame) return { status: 400, body: { error: 'game_mismatch' } }
          if (selectedGame === undefined && owners.length && (game === null || !isLegacyGame(game))) return { status: 200, body: { ok: true, ignored: 'unknown game' } }
          const svc = opts.backends().find(b => b.economy && b.game === game)?.economy
          if (!svc) { log('error', '[webhook] stripe session of an unknown game'); return { status: 200, body: { ok: true, ignored: 'unknown game' } } }
          const r = await svc.stripeCompleted(obj)
          return { status: 200, body: { ok: true, status: r.status } }
        }
        if (type === 'charge.refunded') {
          const full = obj.refunded === true || (typeof obj.amount === 'number' && typeof obj.amount_refunded === 'number' && obj.amount_refunded >= obj.amount)
          const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : ''
          if (!full || !pi) return { status: 200, body: { ok: true, ignored: 'partial or unknown refund' } }
          for (const svc of selectedService ? [selectedService] : candidates) if (await svc.stripeRefunded(pi)) return { status: 200, body: { ok: true, status: 'refunded' } }
          return { status: 200, body: { ok: true, ignored: 'payment not ours' } }
        }
        return { status: 200, body: { ok: true, ignored: String(type) } }
      } catch (e) {
        if (e instanceof StoreError && e.code === 'purchase_refunded') return { status: 200, body: { ok: true, ignored: 'refunded' } }
        log('error', `[webhook] stripe ${String(type)} failed: ${e instanceof Error ? e.name : 'error'}`)
        return { status: 503, body: { error: 'unavailable' } }
      }
  }
  const stripe: HttpRoute = {
    method: 'POST', path: '/webhooks/stripe', maxBytes: 262144,
    handle: stripeHandler(),
  }
  const gameStripe: HttpRoute = { method: 'POST', path: '/webhooks/stripe/:game', maxBytes: 262144,
    handle: async ({ body, headers, params }) => params?.game ? stripeHandler(params.game)({ body, headers }) : { status: 404, body: { error: 'unknown_game' } },
  }
  // Wavedash sends playtest purchases to a second URL; same handler: the signed receipt carries its env, and a
  // PLAYTEST receipt is only accepted when the setting economy.allow_playtest is on (service.ts).
  return [wavedash, { ...wavedash, path: '/webhooks/wavedash/playtest' }, stripe, gameStripe]
}
