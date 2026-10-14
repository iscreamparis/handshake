import type { QueueName } from '../store/types.ts'

export const RESIDENT_AFTER_MS: Record<QueueName, number> = { quick: 8000, ranked: 15000 }

export function rankedWindow(waitMs: number): number {
  return 100 + 100 * Math.floor(waitMs / 5000)
}

export interface Waiter {
  conn: string
  player_id: string
  game: string
  queue: QueueName
  rating: number
  since: number
}

export interface MatchPair {
  game: string
  queue: QueueName
  a: Waiter
  b: Waiter
}

export class Matchmaker {
  private waiters = new Map<string, Waiter>()
  private arrival = new Map<string, number>()
  private counter = 0

  add(waiter: Waiter): boolean {
    if (this.waiters.has(waiter.conn)) return false
    this.waiters.set(waiter.conn, waiter)
    this.arrival.set(waiter.conn, this.counter++)
    return true
  }

  remove(conn: string): Waiter | null {
    const waiter = this.waiters.get(conn)
    if (!waiter) return null
    this.waiters.delete(conn)
    this.arrival.delete(conn)
    return waiter
  }

  get(conn: string): Waiter | null {
    return this.waiters.get(conn) ?? null
  }

  size(game: string, queue: QueueName): number {
    let count = 0
    for (const waiter of this.waiters.values()) {
      if (waiter.game === game && waiter.queue === queue) count++
    }
    return count
  }

  pairs(nowMs: number): MatchPair[] {
    const queued = [...this.waiters.values()]
    const taken = new Set<string>()
    const pairs: MatchPair[] = []
    for (let i = 0; i < queued.length; i++) {
      const waiter = queued[i]
      if (taken.has(waiter.conn)) continue
      let partner: Waiter | null = null
      let bestGap = Number.POSITIVE_INFINITY
      for (let j = i + 1; j < queued.length; j++) {
        const candidate = queued[j]
        if (taken.has(candidate.conn)) continue
        if (candidate.game !== waiter.game || candidate.queue !== waiter.queue) continue
        if (candidate.player_id === waiter.player_id) continue
        if (waiter.queue === 'quick') {
          partner = candidate
          break
        }
        const gap = Math.abs(waiter.rating - candidate.rating)
        const window = Math.max(
          rankedWindow(nowMs - waiter.since),
          rankedWindow(nowMs - candidate.since),
        )
        if (gap > window) continue
        if (gap < bestGap || (gap === bestGap && partner !== null && candidate.since < partner.since)) {
          partner = candidate
          bestGap = gap
        }
      }
      if (!partner) continue
      taken.add(waiter.conn)
      taken.add(partner.conn)
      pairs.push({ game: waiter.game, queue: waiter.queue, a: waiter, b: partner })
    }
    for (const pair of pairs) {
      this.remove(pair.a.conn)
      this.remove(pair.b.conn)
    }
    return pairs
  }

  dueForResident(nowMs: number): Waiter[] {
    const due: Waiter[] = []
    for (const waiter of this.waiters.values()) {
      if (nowMs - waiter.since >= RESIDENT_AFTER_MS[waiter.queue]) due.push(waiter)
    }
    due.sort((a, b) => a.since - b.since || (this.arrival.get(a.conn) ?? 0) - (this.arrival.get(b.conn) ?? 0))
    return due
  }
}
