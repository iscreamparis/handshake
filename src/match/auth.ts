import { guestIdentity } from '../hooks.ts'
import type { HandshakeHooks, VerifiedIdentity } from '../hooks.ts'
import type { Identity, Provider } from '../store/types.ts'

type AuthResolution =
  | { ok: true; identity: Identity; display_name: string }
  | { ok: false; code: 'auth_failed' | 'auth_unavailable' }

export async function resolveIdentity(
  provider: Provider,
  token: string,
  name: string | undefined,
  hooks: HandshakeHooks,
  log: (level: string, msg: string) => void,
): Promise<AuthResolution> {
  let verified: VerifiedIdentity | null
  if (hooks.verifyIdentity) {
    try {
      verified = await hooks.verifyIdentity(provider, token, name)
    } catch {
      log('error', `[match] verifyIdentity failed for ${provider}`)
      return { ok: false, code: 'auth_failed' }
    }
  } else {
    if (provider !== 'guest') return { ok: false, code: 'auth_unavailable' }
    verified = guestIdentity(token, name)
  }

  if (verified === null) return { ok: false, code: 'auth_failed' }
  return {
    ok: true,
    identity: { provider: verified.provider, external_id: verified.external_id },
    display_name: verified.display_name,
  }
}
