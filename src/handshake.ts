// createHandshake: the composition root of the Handshake game server module.

import { loadConfig } from './config.ts'
import type { Config } from './config.ts'
import { RoomHub } from './hub.ts'
import type { HubDeps } from './hub.ts'
import { defaultDeps, readVersion } from './server.ts'
import { startTransport, roomsEndpoint } from './transport.ts'
import type { Transport } from './transport.ts'
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
  const version = readVersion()
  // Kept for the feature milestones (M3 relay, M4 matchmaking); M2 makes no store or hook call.
  const store = options.store
  const hooks = options.hooks
  void store
  void hooks

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
          endpoints: [roomsEndpoint(hub)],
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
      else hub.tick(nowMs)
    },
    close() {
      if (!closing) closing = transport ? transport.close() : Promise.resolve()
      return closing
    },
  }
}
