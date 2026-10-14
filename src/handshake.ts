// createHandshake: the composition root of the Handshake game server module.

import { loadConfig } from './config.ts'
import type { Config } from './config.ts'
import { RoomHub } from './hub.ts'
import type { HubDeps } from './hub.ts'
import { defaultDeps, readVersion } from './server.ts'
import { startTransport, roomsEndpoint } from './transport.ts'
import type { Transport } from './transport.ts'
import { RelayHub } from './relay/hub.ts'
import { relayEndpoint } from './relay/endpoint.ts'
import { MatchService } from './match/service.ts'
import { matchClaims } from './match/messages.ts'
import { createMemoryStore } from './store/memory.ts'
import type { HandshakeHooks } from './hooks.ts'
import type { PlayerStore } from './store/types.ts'

export interface HandshakeOptions {
  config?: Partial<Config>
  deps?: Partial<HubDeps>
  store?: PlayerStore
  hooks?: HandshakeHooks
  autoTick?: boolean
}

export interface Handshake {
  readonly hub: RoomHub
  readonly port: number
  listen(): Promise<{ port: number }>
  tick(nowMs: number): void
  close(): Promise<void>
}

export function createHandshake(options: HandshakeOptions = {}): Handshake {
  const cfg: Config = { ...loadConfig({}), ...options.config }
  const deps: HubDeps = { ...defaultDeps(cfg), ...options.deps }
  const hub = new RoomHub(cfg, deps)
  // MatchService's public constructor takes deps, store, then hooks.
  const match = new MatchService(deps, options.store ?? createMemoryStore(), options.hooks ?? {})
  const relayHub = new RelayHub(deps, match)
  match.attach(relayHub)
  const relay = relayEndpoint(relayHub)
  if (relay.claims) {
    const baseClaims = relay.claims
    relay.claims = (frame) => baseClaims(frame) || matchClaims(frame)
  }
  const version = readVersion()

  let transport: Transport | null = null
  let listening = false
  let port = 0
  let closing: Promise<void> | null = null

  return {
    hub,
    get port() {
      return port
    },
    async listen() {
      if (listening || closing) throw new Error('already listening')
      listening = true
      try {
        transport = await startTransport({
          cfg,
          // Feature endpoints are registered here, in the composition root (ARCHITECTURE: Composition root).
          endpoints: [roomsEndpoint(hub), relay],
          health: () => {
            const { rooms, clients } = hub.stats()
            return { ok: true, rooms, clients, version }
          },
          log: deps.log,
          autoTick: options.autoTick ?? true,
        })
      } catch (e) {
        listening = false
        throw e
      }
      port = transport.port
      return { port }
    },
    tick(nowMs: number) {
      if (transport) transport.tick(nowMs)
      else {
        hub.tick(nowMs)
        relayHub.tick(nowMs)
      }
    },
    close() {
      if (!closing) closing = transport ? transport.close() : Promise.resolve()
      return closing
    },
  }
}
