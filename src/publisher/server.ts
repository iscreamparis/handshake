// HTTP front of the publisher (localhost only, behind nginx; bearer service key).
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PublisherError, type Publisher, type RunRequest } from './runner.ts'

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}
function authorised(req: IncomingMessage, key: string): boolean {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const want = Buffer.from(key)
  return given.length === want.length && timingSafeEqual(given, want)
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 8192) throw new PublisherError(413, 'body too large')
    chunks.push(c as Buffer)
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error()
    return v as Record<string, unknown>
  } catch { throw new PublisherError(400, 'invalid JSON body') }
}
const wavedashToken = (req: IncomingMessage): string | undefined => {
  const h = req.headers['x-wavedash-token']
  return typeof h === 'string' && h !== '' ? h : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function createPublisherServer(publisher: Publisher, opts: { key: string }): Server {
  if (opts.key.length < 24) throw new Error('PUBLISHER_KEY must be at least 24 characters')
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true })
      if (!authorised(req, opts.key)) return send(res, 401, { error: 'unauthorised' })

      if (req.method === 'GET' && path === '/games') return send(res, 200, { games: publisher.games() })
      if (req.method === 'GET' && path === '/auth/status') return send(res, 200, await publisher.authStatus(wavedashToken(req)))
      if (req.method === 'GET' && path === '/runs') return send(res, 200, { runs: await publisher.listRuns() })

      let m = /^\/runs\/([0-9a-f-]{36})$/.exec(path)
      if (req.method === 'GET' && m) {
        const run = await publisher.getRun(m[1]!)
        return run ? send(res, 200, run) : send(res, 404, { error: 'unknown run' })
      }
      if (req.method === 'POST' && path === '/runs') {
        const b = await readJson(req)
        const body: RunRequest = {
          game: str(b.game) ?? '', game_id: str(b.game_id), name: str(b.name),
          publisher_id: typeof b.publisher_id === 'number' || typeof b.publisher_id === 'string' ? b.publisher_id : undefined,
          action: str(b.action) as RunRequest['action'], artifact: str(b.artifact), build_id: str(b.build_id),
          message: str(b.message), title: str(b.title), summary: str(b.summary),
          request_id: typeof b.request_id === 'number' || typeof b.request_id === 'string' ? b.request_id : undefined,
        }
        return send(res, 202, await publisher.startRun(body, wavedashToken(req)))
      }
      m = /^\/artifacts\/([a-z0-9_-]{1,32})$/.exec(path)
      if (m && req.method === 'GET') return send(res, 200, { artifacts: await publisher.listArtifacts(m[1]!) })
      if (m && req.method === 'PUT') return send(res, 201, await publisher.saveArtifact(m[1]!, req))
      return send(res, 404, { error: 'not found' })
    } catch (e) {
      if (e instanceof PublisherError) return send(res, e.status, { error: e.message })
      console.error(e)
      return send(res, 500, { error: 'internal error' })
    }
  })
}
