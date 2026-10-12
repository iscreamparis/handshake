// Standalone rooms server composed over the shared transport.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Config } from './config.ts'
import { RoomHub } from './hub.ts'
import type { HubDeps } from './hub.ts'
import { startTransport, roomsEndpoint } from './transport.ts'

const LEVELS: Record<string, number> = { error: 0, info: 1, debug: 2 }

export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function defaultDeps(cfg: Config): HubDeps {
  const max = LEVELS[cfg.logLevel] ?? 1
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    seed: () => randomBytes(4).readUInt32LE(0),
    log: (level: string, msg: string) => {
      if ((LEVELS[level] ?? 1) > max) return
      if (level === 'error') console.error(msg)
      else console.log(msg)
    },
  }
}

export async function startServer(cfg: Config, deps?: Partial<HubDeps>): Promise<{ port: number; hub: RoomHub; close(): Promise<void> }> {
  const d: HubDeps = { ...defaultDeps(cfg), ...deps }
  const hub = new RoomHub(cfg, d)
  const version = readVersion()
  const { port, close } = await startTransport({
    cfg,
    endpoints: [roomsEndpoint(hub)],
    health: () => {
      const { rooms, clients } = hub.stats()
      return { ok: true, rooms, clients, version }
    },
    log: d.log,
    autoTick: true,
  })
  return { port, hub, close }
}
