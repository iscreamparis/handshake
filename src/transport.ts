// node:http + ws transport: /health, upgrades, heartbeat and endpoint ticks.

import { originAllowed } from './origin.ts'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Config } from './config.ts'
import type { ClientConn, RoomHub } from './hub.ts'
import { MAX_MESSAGE_BYTES, encode } from './protocol.ts'

const TICK_MS = 1000
const CLOSE_GRACE_MS = 1000
const PENDING_FIRST_FRAME_MS = 10000
const WS_OPEN = 1

export interface UpgradeInfo {
  url: string
  headers: IncomingMessage['headers']
}

export interface EndpointSession {
  // Rooms retain their client id in the existing transport log messages.
  id?: string
  message(frame: string): void
  closed(): void
}

export interface Endpoint {
  path: string
  maxPayload: number
  heartbeatMs?: number | null
  oversize?: { frame?: string; code: number; reason: string }
  claims?(frame: string): boolean
  open(conn: ClientConn, info: UpgradeInfo): EndpointSession | null
  tick(nowMs: number): void
}

/** A plain HTTP endpoint (webhooks). The body is read as UTF-8 text, capped at `maxBytes`. */
export interface HttpRoute {
  method: 'POST'
  path: string
  maxBytes?: number
  handle(req: { body: string; headers: IncomingMessage['headers'] }): Promise<{ status: number; body?: unknown }>
}

export interface TransportOptions {
  cfg: Config
  endpoints: Endpoint[]
  health(): unknown
  log(level: string, msg: string): void
  autoTick?: boolean
  http?: HttpRoute[]
}

export interface Transport {
  port: number
  tick(nowMs: number): void
  close(): Promise<void>
}

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

function rawToString(data: unknown): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString()
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString()
  return String((data as Buffer).toString())
}

export function roomsEndpoint(hub: RoomHub): Endpoint {
  return {
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES,
    heartbeatMs: 20000,
    oversize: {
      frame: encode({ t: 'error', code: 'too_large', message: 'message too large' }),
      code: 4009,
      reason: 'too_large',
    },
    open(conn) {
      const id = hub.connect(conn)
      if (id === '') return null
      return {
        id,
        message: (raw) => hub.message(id, raw),
        closed: () => hub.disconnect(id),
      }
    },
    tick: (nowMs) => hub.tick(nowMs),
  }
}

export async function startTransport(opts: TransportOptions): Promise<Transport> {
  const { cfg } = opts
  const { WebSocketServer } = await import('ws')
  const endpointsByPath = new Map<string, Endpoint[]>()
  for (const endpoint of opts.endpoints) {
    const group = endpointsByPath.get(endpoint.path) ?? []
    group.push(endpoint)
    endpointsByPath.set(endpoint.path, group)
  }
  const groups = new Map<string, { endpoints: Endpoint[]; defaultEndpoint: Endpoint; wss: WsServer }>()
  for (const [path, endpoints] of endpointsByPath) {
    const defaults = endpoints.filter((endpoint) => !endpoint.claims)
    if (endpoints.length > 1 && defaults.length !== 1) {
      throw new Error(`Shared path ${path} requires exactly one default endpoint`)
    }
    const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(...endpoints.map((endpoint) => endpoint.maxPayload)) }) as unknown as WsServer
    groups.set(path, { endpoints, defaultEndpoint: endpoints.length === 1 ? endpoints[0] : defaults[0], wss })
  }
  const alive = new WeakMap<WsSocket, boolean>()
  const owners = new WeakMap<WsSocket, Endpoint>()
  const pending = new Map<WsSocket, number>()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(opts.health()))
      return
    }
    const route = req.method === 'POST' ? opts.http?.find((r) => r.path === path) : undefined
    if (route) {
      void serveRoute(route, req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  async function serveRoute(route: HttpRoute, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const max = route.maxBytes ?? 65536
    const reply = (status: number, body: unknown): void => {
      if (res.headersSent) return
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body ?? { ok: true }))
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; reply(408, { error: 'timeout' }); req.destroy() } }, 10000)
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > max) { done = true; clearTimeout(timer); reply(413, { error: 'too large' }); req.destroy(); return }
      chunks.push(c)
    })
    req.on('error', () => { done = true; clearTimeout(timer) })
    req.on('end', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      route.handle({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers }).then(
        (out) => reply(out.status, out.body),
        (e: unknown) => { opts.log('error', `[http] ${route.path}: ${e instanceof Error ? e.message : String(e)}`); reply(500, { error: 'internal' }) },
      )
    })
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0]
    const origin = req.headers.origin
    const originOk = originAllowed(cfg.allowedOrigins, origin)
    const group = groups.get(path)
    if (!group || !originOk) {
      socket.on('error', () => {})
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    group.wss.handleUpgrade(req, socket, head, (ws: WsSocket) => attach(ws, group, { url: req.url ?? '/', headers: req.headers }))
  })

  function attach(ws: WsSocket, group: { endpoints: Endpoint[]; defaultEndpoint: Endpoint }, info: UpgradeInfo): void {
    alive.set(ws, true)
    let endpoint = group.defaultEndpoint
    owners.set(ws, endpoint)
    let session: EndpointSession | null = null
    const shared = group.endpoints.length > 1
    if (shared) pending.set(ws, Date.now())
    // ws answers an oversized frame with close(1009) before emitting 'error'.
    // Remap that one close to the endpoint's protocol error, when configured.
    const wsClose = ws.close.bind(ws)
    ws.close = (code?: number, reason?: string) => {
      if (code === 1009 && endpoint.oversize) {
        try {
          if (endpoint.oversize.frame !== undefined && ws.readyState === WS_OPEN) ws.send(endpoint.oversize.frame)
        } catch { /* socket already failing */ }
        wsClose(endpoint.oversize.code, endpoint.oversize.reason)
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
    if (!shared) session = endpoint.open(conn, info)
    ws.on('pong', () => alive.set(ws, true))
    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (!pending.has(ws) && session === null) return
      try {
        const frame = rawToString(data)
        // The group's ws limit is the largest; enforce the active endpoint's
        // smaller limit as well, including the default while held.
        const bytes = typeof data === 'string' ? Buffer.byteLength(data)
          : Array.isArray(data) ? (data as Buffer[]).reduce((n, chunk) => n + chunk.byteLength, 0)
          : (data as Buffer | ArrayBuffer).byteLength
        if (shared && bytes > endpoint.maxPayload) {
          ws.close(1009)
          return
        }
        if (pending.has(ws)) {
          if (isBinary) return
          for (const candidate of group.endpoints) {
            if (!candidate.claims) continue
            let claimed = false
            try {
              claimed = candidate.claims(frame)
            } catch (e) {
              opts.log('error', `[server] claims: ${e instanceof Error ? e.message : String(e)}`)
            }
            if (claimed) {
              endpoint = candidate
              break
            }
          }
          pending.delete(ws)
          owners.set(ws, endpoint)
          if (bytes > endpoint.maxPayload) {
            ws.close(1009)
            return
          }
          session = endpoint.open(conn, info)
        }
        session?.message(frame)
      } catch (e) {
        opts.log('error', `[server] message ${session?.id ?? ''}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    ws.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
        ws.close(1009)
        return
      }
      opts.log('debug', `[server] socket ${session?.id ?? ''} error: ${err.message}`)
    })
    ws.on('close', () => {
      pending.delete(ws)
      if (session === null) return
      try {
        session.closed()
      } catch (e) {
        opts.log('error', `[server] disconnect ${session.id ?? ''}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  const heartbeats: ReturnType<typeof setInterval>[] = []
  for (const endpoint of opts.endpoints) {
    if (endpoint.heartbeatMs == null) continue
    const heartbeat = setInterval(() => {
      for (const group of groups.values()) {
        for (const ws of group.wss.clients) {
          if (owners.get(ws) !== endpoint) continue
          if (alive.get(ws) === false) {
            ws.terminate()
            continue
          }
          alive.set(ws, false)
          try { ws.ping() } catch { /* closing */ }
        }
      }
    }, endpoint.heartbeatMs)
    heartbeat.unref()
    heartbeats.push(heartbeat)
  }

  function tick(nowMs: number): void {
    for (const endpoint of opts.endpoints) {
      try {
        endpoint.tick(nowMs)
      } catch (e) {
        opts.log('error', `[server] tick: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const [ws, since] of pending) {
      if (nowMs - since >= PENDING_FIRST_FRAME_MS) ws.close(4000, 'hello_timeout')
    }
  }

  const ticker = opts.autoTick ? setInterval(() => tick(Date.now()), TICK_MS) : null
  ticker?.unref()

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
      for (const heartbeat of heartbeats) clearInterval(heartbeat)
      if (ticker) clearInterval(ticker)
      const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()))
      const sockets = [...groups.values()].flatMap(({ wss }) => [...wss.clients])
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
      await Promise.all([...groups.values()].map(({ wss }) => new Promise<void>((resolve) => wss.close(() => resolve()))))
      server.closeAllConnections()
      await httpClosed
    })()
    return closing
  }

  return { port, tick, close }
}
