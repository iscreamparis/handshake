// Matchmaking and identity on the relay socket, as a RelayExtension.
import { randomUUID } from 'node:crypto'
import type { HandshakeHooks, Outcome } from '../hooks.ts'
import type { RelayExtension, RelayHub, RelaySeatRef } from '../relay/hub.ts'
import type { PlayerKind, PlayerStore, Provider, QueueName } from '../store/types.ts'
import { resolveIdentity } from './auth.ts'
import { Matchmaker } from './matchmaker.ts'
import type { MatchPair, Waiter } from './matchmaker.ts'
import { parseMatchMessage } from './messages.ts'
import type { MatchClientMessage } from './messages.ts'

export const FORFEIT_MS = 90000
export const RESULT_WAIT_MS = 60000

export interface MatchDeps { now(): number; log(level: string, msg: string): void }

interface AuthedPlayer { player_id: string; display_name: string; provider: Provider; kind: PlayerKind }

interface ActiveMatch {
  match_id: string
  game: string
  queue: QueueName
  players: [string, string]
  names: [string, string]
  auth: [AuthedPlayer, AuthedPlayer]
  residents: [boolean, boolean]
  conns: [string, string]
  session: string
  reports: [Outcome | null, Outcome | null]
  started_at: number
  firstReportAt: number | null
  down: [number | null, number | null]
}

/** Marks a rejected store Promise so the handler answers store_unavailable. */
class StoreFailure extends Error {
  readonly detail: string
  constructor(cause: unknown) {
    super('store unavailable')
    const code = (cause as { code?: unknown } | null)?.code
    this.detail = typeof code === 'string' ? code : 'rejected'
  }
}

async function st<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (err) { throw new StoreFailure(err) }
}

export class MatchService implements RelayExtension {
  private deps: MatchDeps
  private store: PlayerStore
  private hooks: HandshakeHooks
  private hub: RelayHub | null = null
  private mm = new Matchmaker()
  private authed = new Map<string, AuthedPlayer>()
  private chains = new Map<string, Promise<void>>()
  private pairing = new Set<string>()
  private matches = new Map<string, ActiveMatch>()
  private bySession = new Map<string, ActiveMatch>()
  private byConn = new Map<string, ActiveMatch>()

  constructor(deps: MatchDeps, store: PlayerStore, hooks: HandshakeHooks = {}) {
    this.deps = deps
    this.store = store
    this.hooks = hooks
  }

  attach(hub: RelayHub): void { this.hub = hub }

  message(conn: string, msg: Record<string, unknown>): boolean {
    const parsed = parseMatchMessage(msg)
    if (parsed === null) return false
    const prev = this.chains.get(conn) ?? Promise.resolve()
    const next = prev.then(() => this.handle(conn, parsed))
    this.chains.set(conn, next)
    return true
  }

  connClosed(conn: string, _seat: RelaySeatRef | null): void {
    this.mm.remove(conn)
    this.authed.delete(conn)
    this.chains.delete(conn)
  }

  seatResumed(seat: RelaySeatRef): void {
    const match = this.bySession.get(seat.session)
    if (!match || (seat.seat !== 0 && seat.seat !== 1)) return
    this.authed.set(seat.conn, match.auth[seat.seat])
    this.byConn.delete(match.conns[seat.seat])
    match.conns[seat.seat] = seat.conn
    this.byConn.set(seat.conn, match)
  }

  sessionEnded(_session: string): void {}

  tick(nowMs: number): void {
    void this.runPairing(nowMs)
  }

  stats(): { queued: number; matches: number } {
    let queued = 0
    for (const conn of this.authed.keys()) if (this.mm.get(conn)) queued++
    return { queued, matches: this.matches.size }
  }

  private send(conn: string, msg: Record<string, unknown>): void { this.hub?.send(conn, msg) }
  private error(conn: string, code: string): void { this.hub?.sendError(conn, code, code) }

  private async handle(conn: string, parsed: MatchClientMessage | { error: string }): Promise<void> {
    if ('error' in parsed) return this.error(conn, parsed.error)
    try {
      if (parsed.t === 'auth') await this.auth(conn, parsed)
      else if (parsed.t === 'match_queue') await this.enqueue(conn, parsed.game, parsed.queue)
      else if (parsed.t === 'match_unqueue') {
        if (this.mm.remove(conn)) this.send(conn, { t: 'match_unqueued' })
        else this.error(conn, 'not_queued')
      } else if (this.byConn.get(conn)?.match_id !== parsed.match_id) {
        // Result handling for an active match is added with the results rules.
        this.error(conn, 'unknown_match')
      }
    } catch (err) {
      if (err instanceof StoreFailure) {
        this.deps.log('error', `[match] store ${err.detail} on ${parsed.t} from ${conn}`)
        this.error(conn, 'store_unavailable')
      } else {
        this.deps.log('error', `[match] ${parsed.t} from ${conn} failed`)
        this.error(conn, 'internal')
      }
    }
  }

  private async auth(conn: string, m: { provider: Provider; token: string; name?: string }): Promise<void> {
    if (this.authed.has(conn)) return this.error(conn, 'already_authed')
    const res = await resolveIdentity(m.provider, m.token, m.name, this.hooks, this.deps.log)
    if (!res.ok) return this.error(conn, res.code)
    const { player } = await st(this.store.getOrCreateByIdentity(res.identity, { display_name: res.display_name }))
    const me = { player_id: player.player_id, display_name: player.display_name, provider: m.provider, kind: player.kind }
    this.authed.set(conn, me)
    this.send(conn, { t: 'authed', player_id: me.player_id, display_name: me.display_name, provider: me.provider })
  }

  private async enqueue(conn: string, game: string, queue: QueueName): Promise<void> {
    const me = this.authed.get(conn)
    if (!me) return this.error(conn, 'auth_required')
    if (me.kind === 'resident') return this.error(conn, 'resident_cannot_queue')
    if (this.mm.get(conn) || this.pairing.has(conn)) return this.error(conn, 'already_queued')
    if (this.byConn.has(conn) || this.hub?.seatOf(conn)) return this.error(conn, 'in_match')
    if (queue === 'ranked') {
      const player = await st(this.store.getPlayer(me.player_id))
      if (player?.active_ranked_match) return this.error(conn, 'ranked_busy')
    }
    const rating = await st(this.store.getRating(me.player_id, game))
    if (this.authed.get(conn) !== me) return
    this.mm.add({ conn, player_id: me.player_id, game, queue, rating: rating.rating, since: this.deps.now() })
    this.send(conn, { t: 'match_queued', game, queue, rating: rating.rating, games: rating.games, placement: rating.placement })
    await this.runPairing(this.deps.now())
  }

  private async runPairing(nowMs: number): Promise<void> {
    await Promise.all(this.mm.pairs(nowMs).map((pair) => this.startMatch(pair).catch(() => {
      this.deps.log('error', `[match] pairing ${pair.game}/${pair.queue} failed`)
    })))
  }

  private async startMatch(pair: MatchPair): Promise<void> {
    const { a, b, game, queue } = pair
    const matchId = randomUUID()
    if (queue === 'ranked') {
      this.pairing.add(a.conn).add(b.conn)
      try {
        if (!(await this.lockPair(a, b, matchId))) return
      } finally {
        this.pairing.delete(a.conn)
        this.pairing.delete(b.conn)
      }
    }
    const authA = this.authed.get(a.conn), authB = this.authed.get(b.conn)
    if (!this.hub || !authA || !authB) return
    this.send(a.conn, { t: 'match', match_id: matchId, game, queue, seat: 0, opponent: { player_id: authB.player_id, display_name: authB.display_name } })
    this.send(b.conn, { t: 'match', match_id: matchId, game, queue, seat: 1, opponent: { player_id: authA.player_id, display_name: authA.display_name } })
    const [seatA, seatB] = this.hub.pairInto(a.conn, b.conn, { holdMs: FORFEIT_MS })
    const match: ActiveMatch = {
      match_id: matchId, game, queue,
      players: [authA.player_id, authB.player_id],
      names: [authA.display_name, authB.display_name],
      auth: [authA, authB],
      residents: [false, false],
      conns: [seatA.conn, seatB.conn],
      session: seatA.session,
      reports: [null, null],
      started_at: this.deps.now(),
      firstReportAt: null,
      down: [null, null],
    }
    this.matches.set(matchId, match)
    this.bySession.set(match.session, match)
    this.byConn.set(seatA.conn, match).set(seatB.conn, match)
    this.deps.log('info', `[match] start ${queue} ${game} ${matchId}`)
  }

  /** Takes both ranked locks, or rolls back and answers; true when the match may start. */
  private async lockPair(a: Waiter, b: Waiter, matchId: string): Promise<boolean> {
    const taken: Waiter[] = []
    let busy: Waiter | null = null
    try {
      for (const w of [a, b]) {
        if (!(await st(this.store.lockRanked(w.player_id, matchId)))) { busy = w; break }
        taken.push(w)
      }
    } catch (err) {
      await this.unlock(taken, matchId)
      this.deps.log('error', `[match] store ${(err as StoreFailure).detail} locking ${matchId}`)
      this.error(a.conn, 'store_unavailable')
      this.error(b.conn, 'store_unavailable')
      return false
    }
    const alive = [a, b].filter((w) => this.authed.has(w.conn))
    if (busy || alive.length < 2) {
      await this.unlock(taken, matchId)
      if (busy) this.error(busy.conn, 'ranked_busy')
      for (const w of alive) if (w !== busy) this.mm.add(w)
      return false
    }
    return true
  }

  private async unlock(taken: Waiter[], matchId: string): Promise<void> {
    for (const w of taken) {
      await this.store.unlockRanked(w.player_id, matchId).catch(() => {
        this.deps.log('error', `[match] store unlock failed for ${matchId}`)
      })
    }
  }
}
