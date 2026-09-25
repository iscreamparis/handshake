// node:http + ws transport for the RoomHub: /health, /ws upgrades, heartbeat and hub ticks.

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Config } from './config.ts'
import { RoomHub } from './hub.ts'
import type { ClientConn, HubDeps } from './hub.ts'
import { MAX_MESSAGE_BYTES, encode } from './protocol.ts'

const HEARTBEAT_MS = 20000
const TICK_MS = 1000
const CLOSE_GRACE_MS = 1000
const WS_OPEN = 1
const LEVELS: Record<string, number> = { error: 0, info: 1, debug: 2 }

// Minimal structural types for the parts of 'ws' we use (no @types/ws dependency).
interface WsSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(ev: string, fn: (...args: any[]) => void): void
}
interface WsServer {
  clients: Set<WsSocket>
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WsSocket) => void): void
  close(cb?: (err?: Error) => void): void
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function defaultDeps(cfg: Config): HubDeps {
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

function rawToString(data: unknown): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString()
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString()
  return String((data as Buffer).toString())
}

export async function startServer(cfg: Config, deps?: Partial<HubDeps>): Promise<{ port: number; hub: RoomHub; close(): Promise<void> }> {
  const d: HubDeps = { ...defaultDeps(cfg), ...deps }
  const hub = new RoomHub(cfg, d)
  const version = readVersion()
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES }) as unknown as WsServer
  const alive = new WeakMap<WsSocket, boolean>()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/health') {
      const s = hub.stats()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, rooms: s.rooms, clients: s.clients, version }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0]
    const origin = req.headers.origin
    const originOk = cfg.allowedOrigins.length === 0 || (typeof origin === 'string' && cfg.allowedOrigins.includes(origin))
    if (path !== '/ws' || !originOk) {
      socket.on('error', () => {})
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws: WsSocket) => attach(ws))
  })

  function attach(ws: WsSocket): void {
    alive.set(ws, true)
    // ws answers an oversized frame with close(1009) before emitting 'error'.
    // The protocol wants too_large and close 4009 instead, so remap that one close.
    const wsClose = ws.close.bind(ws)
    ws.close = (code?: number, reason?: string) => {
      if (code === 1009) {
        try {
          if (ws.readyState === WS_OPEN) ws.send(encode({ t: 'error', code: 'too_large', message: 'message too large' }))
        } catch { /* socket already failing */ }
        wsClose(4009, 'too_large')
        return
      }
      wsClose(code, reason)
    }
    const conn: ClientConn = {
      send(text: string): void {
        if (ws.readyState === WS_OPEN) ws.send(text)
      },
      close(code: number, reason: string): void {
        ws.close(code, reason)
      },
    }
    const id = hub.connect(conn)
    ws.on('pong', () => alive.set(ws, true))
    ws.on('message', (data: unknown) => {
      if (id === '') return
      try {
        hub.message(id, rawToString(data))
      } catch (e) {
        d.log('error', `[server] message ${id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    ws.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
        ws.close(1009)
        return
      }
      d.log('debug', `[server] socket ${id} error: ${err.message}`)
    })
    ws.on('close', () => {
      if (id === '') return
      try {
        hub.disconnect(id)
      } catch (e) {
        d.log('error', `[server] disconnect ${id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      try { ws.ping() } catch { /* closing */ }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  const ticker = setInterval(() => {
    try {
      hub.tick(Date.now())
    } catch (e) {
      d.log('error', `[server] tick: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, TICK_MS)
  ticker.unref()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : cfg.port

  let closing: Promise<void> | null = null
  function close(): Promise<void> {
    if (closing) return closing
    closing = (async () => {
      clearInterval(heartbeat)
      clearInterval(ticker)
      const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()))
      const sockets = [...wss.clients]
      const socketsClosed = Promise.all(sockets.map((ws) => new Promise<void>((resolve) => {
        if (ws.readyState === 3) { resolve(); return }
        ws.on('close', () => resolve())
      })))
      for (const ws of sockets) {
        try { ws.close(1001, 'server shutdown') } catch { ws.terminate() }
      }
      const grace = setTimeout(() => { for (const ws of sockets) ws.terminate() }, CLOSE_GRACE_MS)
      await socketsClosed
      clearTimeout(grace)
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      server.closeAllConnections()
      await httpClosed
    })()
    return closing
  }

  return { port, hub, close }
}
