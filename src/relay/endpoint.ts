// GameNet relay endpoint: mounts a RelayHub on RELAY_PATH.

import type { Endpoint } from '../transport.ts'
import { HEARTBEAT_MS, MAX_EXT_BYTES, RELAY_PATH, relayClaims } from './protocol.ts'
import type { RelayHub } from './hub.ts'

export function relayEndpoint(hub: RelayHub): Endpoint {
  const endpoint: Endpoint = {
    path: RELAY_PATH,
    // Relay messages over 4 KiB are invalid in the hub; extension messages (saves, UGC) may reach MAX_EXT_BYTES.
    // A shared path uses the group's largest cap; the rooms endpoint keeps its own smaller limit.
    maxPayload: MAX_EXT_BYTES,
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
