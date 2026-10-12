// GameNet relay endpoint: mounts a RelayHub on RELAY_PATH.

import type { Endpoint } from '../transport.ts'
import { MAX_MESSAGE_BYTES } from '../protocol.ts'
import { HEARTBEAT_MS, RELAY_PATH, relayClaims } from './protocol.ts'
import type { RelayHub } from './hub.ts'

export function relayEndpoint(hub: RelayHub): Endpoint {
  const endpoint: Endpoint = {
    path: RELAY_PATH,
    // relay.mjs sets no maxPayload; frames over 4 KiB are invalid in the hub. A shared path uses the group's largest cap.
    maxPayload: MAX_MESSAGE_BYTES,
    heartbeatMs: HEARTBEAT_MS,
    open(conn, info) {
      const id = hub.connect(conn, info.url)
      return {
        id,
        message: (frame) => hub.message(id, frame),
        closed: () => hub.disconnect(id),
      }
    },
    tick: (nowMs) => hub.tick(nowMs),
  }
  if (RELAY_PATH === '/ws') endpoint.claims = relayClaims
  return endpoint
}
