// Identity verification per provider. A provider is trusted only through an injected IdentityVerifier;
// `guest` has a real one, `wavedash` and `itch` fail closed until a real verifier is supplied.

import { guestIdentity } from './hooks.ts'
import type { HandshakeHooks, VerifiedIdentity } from './hooks.ts'
import type { Provider } from './store/types.ts'

export interface IdentityVerifier {
  /** A verified identity, null to refuse the token, or a throw (any throw refuses the player). `game` is the game of the auth message. */
  verify(token: string, name: string | undefined, game: string | undefined): Promise<VerifiedIdentity | null>
}

/** Thrown by a provider that has no real verifier: the player is refused (`auth_unavailable`), never trusted. */
export class ProviderNotConfiguredError extends Error {
  readonly provider: Provider
  constructor(provider: Provider) {
    super(`provider non configure: ${provider} (no identity verifier injected, authentication refused)`)
    this.name = 'ProviderNotConfiguredError'
    this.provider = provider
  }
}

export const guestVerifier: IdentityVerifier = {
  async verify(token, name) { return guestIdentity(token, name) },
}

export function notConfiguredVerifier(provider: Provider): IdentityVerifier {
  return { async verify() { throw new ProviderNotConfiguredError(provider) } }
}

export type IdentityVerifiers = Record<Provider, IdentityVerifier>

/** The default set: guest is real, wavedash and itch refuse. Pass `overrides` to plug real verifiers. */
export function defaultVerifiers(overrides: Partial<IdentityVerifiers> = {}): IdentityVerifiers {
  return {
    guest: guestVerifier,
    wavedash: notConfiguredVerifier('wavedash'),
    itch: notConfiguredVerifier('itch'),
    ...overrides,
  }
}

/** The `verifyIdentity` hook over a verifier per provider. A verified identity must carry the requested provider. */
export function verifyIdentityHook(verifiers: IdentityVerifiers = defaultVerifiers()): NonNullable<HandshakeHooks['verifyIdentity']> {
  return async (provider, token, name, game) => {
    const verified = await verifiers[provider].verify(token, name, game)
    if (verified !== null && verified.provider !== provider) return null
    return verified
  }
}
