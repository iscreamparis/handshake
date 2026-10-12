import { createHash } from 'node:crypto'
import type { Provider, QueueName, RatingChange } from './store/types.ts'

export type Outcome = 'win' | 'loss' | 'draw'

export interface VerifiedIdentity {
  provider: Provider
  external_id: string
  display_name: string
}

export interface ResidentSocket {
  send(frame: string): void
}

export interface ResidentSink {
  message(frame: string): void
}

/**
 * Open once at match start. Frames sent through socket.send are handled as an
 * authenticated client of player_id, and server frames are delivered to
 * sink.message. Calling release() means the seat was not used.
 */
export interface ResidentSeat {
  player_id: string
  socket: ResidentSocket
  sink: ResidentSink
  release(): void
}

export interface MatchRecord {
  match_id: string
  game: string
  queue: QueueName
  players: [string, string]
  residents: [boolean, boolean]
  status: 'complete' | 'void' | 'forfeit'
  reason: 'agreed' | 'disagreement' | 'no_report' | 'disconnect' | 'both_disconnected'
  reports: [Outcome | null, Outcome | null]
  score_a: 0 | 0.5 | 1 | null
  ratings: [RatingChange, RatingChange] | null
  started_at: number
  ended_at: number
}

export interface HandshakeHooks {
  verifyIdentity?: (provider: Provider, token: string, name?: string) => Promise<VerifiedIdentity | null>
  pickResident?: (game: string, queue: QueueName, rating: number) => Promise<ResidentSeat | null>
  onMatchEnd?: (record: MatchRecord) => void | Promise<void>
}

export function guestIdentity(token: string, name?: string): VerifiedIdentity | null {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null

  const external_id = createHash('sha256').update(token).digest('hex')
  const trimmedName = name?.trim()
  const display_name = trimmedName && trimmedName.length >= 3 && trimmedName.length <= 16
    ? trimmedName
    : 'Guest-' + external_id.slice(0, 4).toUpperCase()

  return { provider: 'guest', external_id, display_name }
}
