// Stripe through the CRM bridge. Handshake holds NO Stripe key and no webhook secret: the tenant keeps them in its
// Reglages and the bridge (`/api/etcito-publisher/stripe/*`, protected by the game's gsk_ service key) creates the
// Checkout Session and verifies the webhook signature. Handshake only (1) asks for a session for a product of
// etc_products, (2) hands each raw webhook body + Stripe-Signature to the bridge, and (3) credits idempotently
// from the verified event. No Stripe SDK: the events are plain JSON.

export interface StripeBridge {
  checkout(req: { product_code: string; player_id: string; game: string; success_url: string; cancel_url: string }): Promise<{ url: string; session_id: string }>
  /** `event` is the parsed Stripe event when the signature is valid, null when it is not. Throws when the bridge is unreachable. */
  verify(rawBody: string, signature: string): Promise<Record<string, unknown> | null>
}

export class StripeBridgeError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`stripe bridge: ${detail}`)
    this.name = 'StripeBridgeError'
    this.status = status
  }
}

export function createStripeBridge(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): StripeBridge {
  const f = opts.fetch ?? fetch
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/etcito-publisher/stripe`
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` }
  async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await f(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    } catch {
      throw new StripeBridgeError(502, 'unreachable')
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new StripeBridgeError(res.status, typeof json.detail === 'string' ? json.detail.slice(0, 200) : `HTTP ${res.status}`)
    return json
  }
  return {
    async checkout(req) {
      const j = await call('/checkout', req)
      if (typeof j.url !== 'string' || typeof j.session_id !== 'string') throw new StripeBridgeError(502, 'bad answer')
      return { url: j.url, session_id: j.session_id }
    },
    async verify(rawBody, signature) {
      const j = await call('/verify', { payload: rawBody, signature })
      if (j.valid !== true) return null
      return typeof j.event === 'object' && j.event !== null ? (j.event as Record<string, unknown>) : null
    },
  }
}
