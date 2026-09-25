// ICE servers for a client: STUN, plus TURN with coturn REST credentials.

import { createHmac } from 'node:crypto'
import type { Config } from './config.ts'
import type { IceServer } from './protocol.ts'

export const TURN_TTL_SEC = 86400

export function iceServersFor(clientId: string, cfg: Config, nowSec: number): IceServer[] {
  const out: IceServer[] = []
  if (cfg.stunUrls.length > 0) out.push({ urls: cfg.stunUrls.slice() })
  if (cfg.turnSecret && cfg.turnUrls.length > 0) {
    const username = `${Math.floor(nowSec) + TURN_TTL_SEC}:${clientId}`
    const credential = createHmac('sha1', cfg.turnSecret).update(username).digest('base64')
    out.push({ urls: cfg.turnUrls.slice(), username, credential })
  }
  return out
}
