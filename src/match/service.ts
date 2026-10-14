// Matchmaking and identity on the relay socket, as a RelayExtension.
import { randomUUID } from 'node:crypto'
import type { HandshakeHooks, MatchRecord, Outcome, ResidentSeat } from '../hooks.ts'
import type { ClientConn } from '../hub.ts'
import { RELAY_PATH } from '../relay/protocol.ts'
import type { RelayExtension, RelayHub, RelaySeatRef } from '../relay/hub.ts'
import type { PlayerKind, PlayerStore, Provider, QueueName, RatingChange } from '../store/types.ts'
import { singleStoreRouter } from '../store/games.ts'
import type { GameRouter } from '../store/games.ts'
import { resolveIdentity } from './auth.ts'
import { Matchmaker } from './matchmaker.ts'
import type { MatchPair, Waiter } from './matchmaker.ts'
import { parseMatchMessage } from './messages.ts'
import { isEconomyMessage } from './messages.ts'
import type { EconomyClientMessage, MatchClientMessage } from './messages.ts'
import { StoreError } from '../store/errors.ts'
import { EconomyUnavailable } from '../economy/service.ts'
import type { EconomyService } from '../economy/service.ts'
import { WavedashError } from '../economy/wavedash.ts'
import { StripeBridgeError } from '../economy/stripe.ts'

export const FORFEIT_MS = 90000
export const RESULT_WAIT_MS = 60000

export interface MatchDeps { now(): number; log(level: string, msg: string): void }

/** `game` is the game the connection authenticated into (null with a single shared store: any game). */
interface AuthedPlayer { player_id: string; display_name: string; provider: Provider; kind: PlayerKind; game: string | null }

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
  /** Set once the end is decided; kept while a ranked rating cannot be applied yet. */
  ending: { status: MatchRecord['status']; reason: MatchRecord['reason']; score_a: 0 | 0.5 | 1 | null } | null
  busy: boolean
}

const SCORE: Record<Outcome, 0 | 0.5 | 1> = { win: 1, draw: 0.5, loss: 0 }
const OUTCOME = (score: number): Outcome => score === 1 ? 'win' : score === 0 ? 'loss' : 'draw'

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
  private router: GameRouter
  private hooks: HandshakeHooks
  private hub: RelayHub | null = null
  private mm = new Matchmaker()
  private authed = new Map<string, AuthedPlayer>()
  private chains = new Map<string, Promise<void>>()
  private pairing = new Set<string>()
  /** Waiter conns with a pickResident call (or its seat check) in flight. */
  private picking = new Set<string>()
  private economies = new WeakSet<EconomyService>()
  private matches = new Map<string, ActiveMatch>()
  private bySession = new Map<string, ActiveMatch>()
  private byConn = new Map<string, ActiveMatch>()

  /** `store` is one PlayerStore for every game, or a GameRouter (one store per game, chosen by the game of auth / match_queue). */
  constructor(deps: MatchDeps, store: PlayerStore | GameRouter, hooks: HandshakeHooks = {}) {
    this.deps = deps
    this.router = 'resolve' in store ? store : singleStoreRouter(store)
    this.hooks = hooks
  }

  attach(hub: RelayHub): void { this.hub = hub }

  /** The store of a game already validated by auth / enqueue. */
  private storeFor(game: string): PlayerStore {
    const backend = this.router.resolve(game)
    if (!backend) throw new Error(`no store for game ${game}`)
    return backend.store
  }

  message(conn: string, msg: Record<string, unknown>): boolean {
    const parsed = parseMatchMessage(msg)
    if (parsed === null) return false
    const prev = this.chains.get(conn) ?? Promise.resolve()
    const next = prev.then(() => this.handle(conn, parsed))
    this.chains.set(conn, next)
    return true
  }

  connClosed(conn: string, seat: RelaySeatRef | null): void {
    const match = seat ? this.bySession.get(seat.session) : undefined
    if (match && seat && (seat.seat === 0 || seat.seat === 1)) match.down[seat.seat] = this.deps.now() + FORFEIT_MS
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
    match.down[seat.seat] = null
    this.byConn.set(seat.conn, match)
  }

  sessionEnded(session: string): void {
    const match = this.bySession.get(session)
    if (!match || match.ending) return
    if (this.checkForfeit(match)) return
    if (match.firstReportAt === null) match.firstReportAt = this.deps.now()
  }

  tick(nowMs: number): void {
    void this.runPairing(nowMs)
    this.runResidents(nowMs)
    for (const match of [...this.matches.values()]) {
      if (match.ending) {
        if (!match.busy) this.end(match)
      } else if (!this.checkForfeit(match) && match.firstReportAt !== null &&
        match.firstReportAt + RESULT_WAIT_MS <= nowMs && match.reports.includes(null)) {
        this.decide(match, 'void', 'no_report', null)
      }
    }
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
      else if (isEconomyMessage(parsed)) await this.economy(conn, parsed)
      else if (parsed.t === 'match_queue') await this.enqueue(conn, parsed.game, parsed.queue)
      else if (parsed.t === 'match_unqueue') {
        if (this.mm.remove(conn)) this.send(conn, { t: 'match_unqueued' })
        else this.error(conn, 'not_queued')
      } else await this.result(conn, parsed.match_id, parsed.outcome)
    } catch (err) {
      if (isEconomyMessage(parsed)) return this.economyError(conn, parsed, err)
      if (err instanceof StoreFailure) {
        this.deps.log('error', `[match] store ${err.detail} on ${parsed.t} from ${conn}`)
        this.error(conn, 'store_unavailable')
      } else {
        this.deps.log('error', `[match] ${parsed.t} from ${conn} failed`)
        this.error(conn, 'internal')
      }
    }
  }

  private async auth(conn: string, m: { provider: Provider; token: string; name?: string; game?: string }): Promise<void> {
    if (this.authed.has(conn)) return this.error(conn, 'already_authed')
    const backend = this.router.resolve(m.game)
    if (!backend) return this.error(conn, 'bad_message')
    const res = await resolveIdentity(m.provider, m.token, m.name, this.hooks, this.deps.log, backend.game ?? m.game)
    if (!res.ok) return this.error(conn, res.code)
    const { player } = await st(backend.store.getOrCreateByIdentity(res.identity, { display_name: res.display_name }))
    const me = { player_id: player.player_id, display_name: player.display_name, provider: m.provider, kind: player.kind, game: backend.game }
    this.authed.set(conn, me)
    this.watchEconomy(backend.economy, backend.game)
    this.send(conn, { t: 'authed', player_id: me.player_id, display_name: me.display_name, provider: me.provider })
  }

  // --- economy (docs/CONTRACT.md r4 s8) -----------------------------------------------------------------------

  /** Pushes `eco_state` to every connection of a player whose economy changed outside a request (webhook purchase). */
  private watchEconomy(eco: EconomyService | undefined, game: string | null): void {
    if (!eco || this.economies.has(eco)) return
    this.economies.add(eco)
    eco.onChange((playerId) => {
      for (const [conn, me] of this.authed) {
        if (me.player_id !== playerId || (me.game !== null && me.game !== game)) continue
        void eco.state(playerId).then((s) => this.send(conn, { t: 'eco_state', ...s }), () => undefined)
      }
    })
  }

  private async economy(conn: string, m: EconomyClientMessage): Promise<void> {
    const me = this.authed.get(conn)
    if (!me) return this.error(conn, 'auth_required')
    const backend = this.router.resolve(me.game ?? undefined)
    const eco = backend?.economy
    if (!eco) return this.error(conn, 'economy_unavailable')
    const echo = 'op' in m && m.op !== undefined ? { op: m.op } : {}
    const pid = me.player_id
    switch (m.t) {
      case 'eco_get': return this.send(conn, { t: 'eco_state', ...echo, ...(await eco.state(pid)) })
      case 'eco_products': return this.send(conn, { t: 'eco_products', ...echo, products: await eco.products() })
      case 'eco_reward': {
        const r = await eco.reward(pid, m.reward_id)
        return this.send(conn, { t: 'eco_reward', ...echo, reward_id: m.reward_id, granted: r.result.granted, coins: r.result.coins, applied: r.applied })
      }
      case 'eco_buy': {
        const r = await eco.buy(pid, m.op, m.product, m.qty)
        return this.send(conn, { t: 'eco_bought', ...echo, ...r.result, applied: r.applied })
      }
      case 'eco_open': {
        const r = await eco.open(pid, m.op, m.pack_type)
        return this.send(conn, { t: 'eco_opened', ...echo, ...r.result, applied: r.applied })
      }
      case 'eco_wavedash': {
        const r = await eco.wavedashFromClient(pid, m.receipt_jwt, m.user_jwt)
        return this.send(conn, { t: 'eco_purchase', ...echo, ...r })
      }
      case 'eco_stripe': {
        if (!/^https?:\/\/[^\s]+$/.test(m.return_url)) return this.economyError(conn, m, new StoreError('bad_argument', 'bad_return_url'))
        const s = await eco.stripeCheckout(pid, m.product, m.return_url)
        return this.send(conn, { t: 'eco_checkout', ...echo, url: s.url, session_id: s.session_id })
      }
    }
  }

  private economyError(conn: string, m: { t: string; op?: string }, err: unknown): void {
    let code = 'store_unavailable'
    if (err instanceof StoreError) {
      code = err.code === 'bad_argument' ? (err.message === 'bad_return_url' ? 'bad_return_url' : 'bad_message') : err.code === 'not_found' ? 'unknown_product' : err.code
    } else if (err instanceof WavedashError) {
      code = err.code === 'not_production' ? 'not_production' : err.code === 'receipt_mismatch' ? 'receipt_mismatch' : err.code === 'fulfill_failed' ? 'store_unavailable' : 'bad_receipt'
    } else if (err instanceof EconomyUnavailable) {
      code = 'economy_unavailable'
    } else if (err instanceof StripeBridgeError) {
      code = 'payment_unavailable'
      this.deps.log('error', `[economy] ${m.t}: ${err.message}`)
    } else {
      this.deps.log('error', `[economy] ${m.t} from ${conn} failed`)
    }
    this.hub?.send(conn, { t: 'error', reason: code, ...(m.op !== undefined ? { op: m.op } : {}) })
  }

  private async enqueue(conn: string, game: string, queue: QueueName): Promise<void> {
    const me = this.authed.get(conn)
    if (!me) return this.error(conn, 'auth_required')
    if (me.kind === 'resident') return this.error(conn, 'resident_cannot_queue')
    if (me.game !== null && me.game !== game) return this.error(conn, 'bad_message')
    const backend = this.router.resolve(game)
    if (!backend) return this.error(conn, 'bad_message')
    if (!backend.queues().includes(queue)) return this.error(conn, 'bad_queue')
    if (this.mm.get(conn) || this.pairing.has(conn)) return this.error(conn, 'already_queued')
    if (this.byConn.has(conn) || this.hub?.seatOf(conn)) return this.error(conn, 'in_match')
    if (queue === 'ranked') {
      const player = await st(backend.store.getPlayer(me.player_id))
      if (player?.active_ranked_match) return this.error(conn, 'ranked_busy')
    }
    const rating = await st(backend.store.getRating(me.player_id, game))
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

  private runResidents(nowMs: number): void {
    if (!this.hooks.pickResident) return
    for (const w of this.mm.dueForResident(nowMs)) {
      if (this.picking.has(w.conn)) continue
      this.picking.add(w.conn)
      void this.pickFor(w)
    }
  }

  /** One pickResident call for a waiter; null or a throw is retried at the next tick. */
  private async pickFor(w: Waiter): Promise<void> {
    let seat: ResidentSeat | null = null
    try {
      seat = (await this.hooks.pickResident?.(w.game, w.queue, w.rating)) ?? null
    } catch {
      this.deps.log('error', `[match] pickResident failed for ${w.game}/${w.queue}`)
    }
    if (!seat) {
      this.picking.delete(w.conn)
      return
    }
    try {
      await this.useResident(w, seat)
    } catch {
      this.deps.log('error', `[match] resident seat for ${w.conn} failed`)
    } finally {
      this.picking.delete(w.conn)
    }
  }

  private async useResident(w: Waiter, seat: ResidentSeat): Promise<void> {
    const hub = this.hub
    if (!hub || this.mm.get(w.conn) !== w) return seat.release()
    let player
    try {
      player = await this.storeFor(w.game).getPlayer(seat.player_id)
    } catch (err) {
      seat.release()
      this.deps.log('error', `[match] store ${new StoreFailure(err).detail} checking resident ${seat.player_id}`)
      return this.error(w.conn, 'store_unavailable')
    }
    if (player?.kind !== 'resident') {
      seat.release()
      return this.deps.log('error', `[match] seat player ${seat.player_id} is not a resident`)
    }
    if (this.mm.get(w.conn) !== w) return seat.release()
    const residentConn: ClientConn = { send: (text) => seat.sink.message(text), close: () => {} }
    const rc = hub.connect(residentConn, RELAY_PATH)
    if (!rc) return seat.release()
    this.mm.remove(w.conn)
    this.authed.set(rc, {
      player_id: player.player_id, display_name: player.display_name,
      provider: player.identities[0]?.provider ?? 'guest', kind: 'resident', game: w.game,
    })
    seat.socket.send = (frame) => hub.message(rc, frame)
    const rw: Waiter = { conn: rc, player_id: player.player_id, game: w.game, queue: w.queue, rating: w.rating, since: this.deps.now() }
    let started = false
    try {
      started = await this.startMatch({ game: w.game, queue: w.queue, a: w, b: rw }, [false, true])
    } finally {
      if (!started) {
        seat.release()
        hub.disconnect(rc)
      }
    }
  }

  /** Pairs two waiters into a relay session; true when the match started. */
  private async startMatch(pair: MatchPair, residents: [boolean, boolean] = [false, false]): Promise<boolean> {
    const { a, b, game, queue } = pair
    const matchId = randomUUID()
    if (queue === 'ranked') {
      this.pairing.add(a.conn).add(b.conn)
      try {
        if (!(await this.lockPair(a, b, matchId, residents))) return false
      } finally {
        this.pairing.delete(a.conn)
        this.pairing.delete(b.conn)
      }
    }
    const authA = this.authed.get(a.conn), authB = this.authed.get(b.conn)
    if (!this.hub || !authA || !authB) return false
    this.send(a.conn, { t: 'match', match_id: matchId, game, queue, seat: 0, opponent: { player_id: authB.player_id, display_name: authB.display_name } })
    this.send(b.conn, { t: 'match', match_id: matchId, game, queue, seat: 1, opponent: { player_id: authA.player_id, display_name: authA.display_name } })
    const [seatA, seatB] = this.hub.pairInto(a.conn, b.conn, { holdMs: FORFEIT_MS })
    const match: ActiveMatch = {
      match_id: matchId, game, queue,
      players: [authA.player_id, authB.player_id],
      names: [authA.display_name, authB.display_name],
      auth: [authA, authB],
      residents: [residents[0], residents[1]],
      conns: [seatA.conn, seatB.conn],
      session: seatA.session,
      reports: [null, null],
      started_at: this.deps.now(),
      firstReportAt: null,
      down: [null, null],
      ending: null,
      busy: false,
    }
    this.matches.set(matchId, match)
    this.bySession.set(match.session, match)
    this.byConn.set(seatA.conn, match).set(seatB.conn, match)
    this.deps.log('info', `[match] start ${queue} ${game} ${matchId}`)
    return true
  }

  /** Takes both ranked locks, or rolls back and answers; true when the match may start. */
  private async lockPair(a: Waiter, b: Waiter, matchId: string, residents: [boolean, boolean]): Promise<boolean> {
    const taken: Waiter[] = []
    const isResident = (w: Waiter) => residents[w === a ? 0 : 1]
    let busy: Waiter | null = null
    let current = a
    try {
      for (const w of [a, b]) {
        current = w
        if (!(await st(this.storeFor(a.game).lockRanked(w.player_id, matchId)))) { busy = w; break }
        taken.push(w)
      }
    } catch (err) {
      await this.unlock(taken, matchId, a.game)
      this.deps.log('error', `[match] store ${(err as StoreFailure).detail} locking ${matchId}`)
      if (isResident(current)) {
        for (const w of [a, b]) if (!isResident(w) && this.authed.has(w.conn)) this.mm.add(w)
      } else {
        for (const w of [a, b]) if (!isResident(w)) this.error(w.conn, 'store_unavailable')
      }
      return false
    }
    const alive = [a, b].filter((w) => this.authed.has(w.conn))
    if (busy || alive.length < 2) {
      await this.unlock(taken, matchId, a.game)
      if (busy && !isResident(busy)) this.error(busy.conn, 'ranked_busy')
      for (const w of alive) if (w !== busy && !isResident(w)) this.mm.add(w)
      return false
    }
    return true
  }

  private async unlock(taken: Waiter[], matchId: string, game: string): Promise<void> {
    for (const w of taken) {
      await this.storeFor(game).unlockRanked(w.player_id, matchId).catch(() => {
        this.deps.log('error', `[match] store unlock failed for ${matchId}`)
      })
    }
  }

  private async result(conn: string, matchId: string, outcome: Outcome): Promise<void> {
    const match = this.matches.get(matchId)
    const seat = match ? match.players.indexOf(this.authed.get(conn)?.player_id ?? '') : -1
    if (!match || (seat !== 0 && seat !== 1)) return this.error(conn, 'unknown_match')
    if (match.reports[seat] !== null) return this.error(conn, 'already_reported')
    match.reports[seat] = outcome
    match.firstReportAt ??= this.deps.now()
    this.send(conn, { t: 'result_ack', match_id: matchId })
    const [r0, r1] = match.reports
    if (r0 === null || r1 === null || match.ending) return
    if (SCORE[r0] + SCORE[r1] === 1) await this.decide(match, 'complete', 'agreed', SCORE[r0])
    else await this.decide(match, 'void', 'disagreement', null)
  }

  /** Ends the match when a seat's forfeit deadline lapsed; true when it did. */
  private checkForfeit(match: ActiveMatch): boolean {
    const now = this.deps.now()
    const lapsed = match.down.map((d) => d !== null && d <= now)
    if (lapsed[0] && lapsed[1]) void this.decide(match, 'void', 'both_disconnected', null)
    else if (lapsed[0] || lapsed[1]) void this.decide(match, 'forfeit', 'disconnect', lapsed[0] ? 0 : 1)
    else return false
    return true
  }

  private decide(match: ActiveMatch, status: MatchRecord['status'], reason: MatchRecord['reason'],
    score_a: 0 | 0.5 | 1 | null): Promise<void> {
    match.ending = { status, reason, score_a }
    return this.end(match)
  }

  /** Applies or unlocks the ranked state, then notifies, ends the session and calls onMatchEnd. */
  private async end(match: ActiveMatch): Promise<void> {
    const { status, reason, score_a } = match.ending!
    match.busy = true
    let ratings: [RatingChange, RatingChange] | null = null
    try {
      if (match.queue === 'ranked' && score_a !== null) {
        const res = await this.storeFor(match.game).applyRankedResult({
          match_id: match.match_id, game: match.game, a: match.players[0], b: match.players[1], score_a,
        })
        ratings = [res.a, res.b]
      } else if (match.queue === 'ranked') {
        for (const id of match.players) {
          await this.storeFor(match.game).unlockRanked(id, match.match_id).catch(() => {
            this.deps.log('error', `[match] store unlock failed for ${match.match_id}`)
          })
        }
      }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      this.deps.log('error', `[match] store ${typeof code === 'string' ? code : 'rejected'} applying ${match.match_id}`)
      for (const c of match.conns) this.error(c, 'store_unavailable')
      match.busy = false
      return
    }
    this.drop(match)
    match.conns.forEach((c, seat) => {
      const score = score_a === null ? null : seat === 0 ? score_a : 1 - score_a
      const r = ratings?.[seat]
      this.send(c, {
        t: 'match_end', match_id: match.match_id, status, outcome: score === null ? null : OUTCOME(score),
        ...(r ? { rating: { before: r.before, after: r.after, games: r.games, placement: r.placement } } : {}),
      })
    })
    if (status === 'forfeit' || reason === 'no_report' || reason === 'both_disconnected') {
      this.hub?.endSession(match.session, reason)
    }
    match.residents.forEach((r, seat) => { if (r) this.hub?.disconnect(match.conns[seat]) })
    this.deps.log('info', `[match] ${status} ${reason} ${match.match_id}`)
    const record: MatchRecord = {
      match_id: match.match_id, game: match.game, queue: match.queue,
      players: [match.players[0], match.players[1]], residents: [match.residents[0], match.residents[1]],
      status, reason, reports: [match.reports[0], match.reports[1]], score_a, ratings,
      started_at: match.started_at, ended_at: this.deps.now(),
    }
    try {
      await this.hooks.onMatchEnd?.(record)
    } catch {
      this.deps.log('error', `[match] onMatchEnd failed for ${match.match_id}`)
    }
  }

  private drop(match: ActiveMatch): void {
    this.matches.delete(match.match_id)
    if (this.bySession.get(match.session) === match) this.bySession.delete(match.session)
    for (const c of match.conns) if (this.byConn.get(c) === match) this.byConn.delete(c)
  }
}
