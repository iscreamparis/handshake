import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryTableApi } from '../src/store/tables.ts'
import { StoreError } from '../src/store/errors.ts'
import { createProgressService } from '../src/achievements/service.ts'
import { matchesFilter, parseFilter } from '../src/achievements/rules.ts'

async function rig() {
  const clock = { t: 1_000_000 }
  const api = createMemoryTableApi()
  const stat = (code: string, over: Record<string, unknown> = {}) =>
    api.insert('etc_stats', { code, label: code, value_type: 'int', aggregation: 'sum', client_writable: false, active: true, sort_order: 0, ...over })
  const ach = (code: string, over: Record<string, unknown> = {}) =>
    api.insert('etc_achievements', { code, title_fr: `${code} fr`, title_en: `${code} en`, description_fr: 'd fr', description_en: 'd en', secret: false, rule_type: 'stat', rule_threshold: 1, active: true, sort_order: 0, ...over })
  await stat('levels_done', { client_writable: true, max_delta: 5 })
  await stat('best_time', { client_writable: true, aggregation: 'min', value_type: 'float' })
  await stat('score_max', { client_writable: true, aggregation: 'max' })
  await ach('ten_levels', { rule_stat: 'levels_done', rule_threshold: 10 })
  await ach('fast', { rule_stat: 'best_time', rule_threshold: 30 })
  await ach('first_win', { rule_type: 'event', rule_event: 'match_end', rule_filter: 'outcome=win', rule_stat: null })
  await ach('ranked_win', { rule_type: 'event', rule_event: 'match_end', rule_filter: 'outcome=win,queue=ranked', secret: true })
  await ach('five_wins', { rule_stat: 'matches_won', rule_threshold: 5 })
  await ach('streak_3', { rule_stat: 'win_streak_best', rule_threshold: 3 })
  await ach('collector', { rule_stat: 'cards_unique', rule_threshold: 4 })
  await ach('gm', { rule_type: 'manual' })
  await ach('off', { rule_stat: 'levels_done', rule_threshold: 1, active: false })
  const svc = createProgressService({ api, now: () => clock.t, ttlMs: 0 })
  return { api, clock, svc, stat, ach }
}
const codes = (l: Array<{ code: string }>): string[] => l.map(a => a.code).sort()
const fails = async (p: Promise<unknown>, code: string): Promise<void> => {
  try { await p } catch (e) { assert.ok(e instanceof StoreError, String(e)); assert.equal(e.code, code); return }
  assert.fail(`expected ${code}`)
}

test('filter: parse and match', () => {
  const c = parseFilter('outcome=win, queue=ranked,rating_after>=2800')
  assert.equal(c.length, 3)
  assert.ok(matchesFilter(c, { outcome: 'win', queue: 'ranked', rating_after: 2900 }))
  assert.ok(!matchesFilter(c, { outcome: 'win', queue: 'ranked', rating_after: 2799 }))
  assert.ok(!matchesFilter(c, { outcome: 'win', queue: 'quick', rating_after: 3000 }))
  assert.ok(!matchesFilter(c, { outcome: 'win', queue: 'ranked' })) // missing field never matches
  assert.ok(matchesFilter(parseFilter('outcome!=loss'), { outcome: 'win' }))
  assert.ok(matchesFilter(parseFilter(''), {}))
  assert.throws(() => parseFilter('outcome'))
  assert.throws(() => parseFilter('=x'))
})

test('stat_report: only client_writable stats, validated, aggregated', async () => {
  const r = await rig()
  await fails(r.svc.report('p1', 'o1', 'ghost', 1), 'unknown_stat')
  await fails(r.svc.report('p1', 'o1', 'matches_won', 1), 'stat_not_writable') // built-in
  await fails(r.svc.report('p1', 'o1', 'levels_done', 6), 'bad_argument') // max_delta 5
  await fails(r.svc.report('p1', 'o1', 'levels_done', -1), 'bad_argument')
  await fails(r.svc.report('p1', 'o1', 'levels_done', 1.5), 'bad_argument')
  await fails(r.svc.report('p1', 'bad op', 'levels_done', 1), 'bad_argument')
  assert.equal((await r.svc.report('p1', 'o1', 'levels_done', 3)).value, 3)
  assert.equal((await r.svc.report('p1', 'o2', 'levels_done', 4)).value, 7)
  assert.equal((await r.svc.report('p1', 'm1', 'score_max', 100)).value, 100)
  assert.equal((await r.svc.report('p1', 'm2', 'score_max', 40)).value, 100)
  assert.equal((await r.svc.report('p1', 't1', 'best_time', 41.5)).value, 41.5)
  assert.equal((await r.svc.report('p1', 't2', 'best_time', 50)).value, 41.5)
  assert.deepEqual(await r.svc.stats('p1'), { levels_done: 7, score_max: 100, best_time: 41.5 })
  assert.deepEqual(await r.svc.stats('p2'), {})
})

test('stat_report: an op is applied once, a replay with other parameters is a conflict', async () => {
  const r = await rig()
  const a = await r.svc.report('p1', 'op-1', 'levels_done', 4)
  assert.deepEqual([a.value, a.applied], [4, true])
  const b = await r.svc.report('p1', 'op-1', 'levels_done', 4)
  assert.deepEqual([b.value, b.applied, b.unlocked], [4, false, []])
  await fails(r.svc.report('p1', 'op-1', 'levels_done', 5), 'tx_conflict')
  // the op is per player
  assert.equal((await r.svc.report('p2', 'op-1', 'levels_done', 1)).applied, true)
  assert.equal((await r.svc.stats('p1')).levels_done, 4)
})

test('stat rule unlocks at the threshold, once; min stats unlock below it; ack marks the copy to Wavedash', async () => {
  const r = await rig()
  const a = await r.svc.report('p1', 'o1', 'levels_done', 5)
  assert.deepEqual(a.unlocked, [])
  const b = await r.svc.report('p1', 'o2', 'levels_done', 5)
  assert.deepEqual(codes(b.unlocked), ['ten_levels'])
  assert.equal(b.unlocked[0]!.unlocked, true)
  const c = await r.svc.report('p1', 'o3', 'levels_done', 1)
  assert.deepEqual(c.unlocked, []) // already unlocked: never reported twice
  assert.deepEqual(codes((await r.svc.report('p1', 't1', 'best_time', 29.9)).unlocked), ['fast'])
  const l = await r.svc.list('p1')
  assert.deepEqual(l.pending_sync.sort(), ['fast', 'ten_levels'])
  assert.deepEqual(await r.svc.ack('p1', ['ten_levels', 'ghost', 'gm']), ['ten_levels'])
  assert.deepEqual(await r.svc.ack('p1', ['ten_levels']), []) // second ack changes nothing
  assert.deepEqual((await r.svc.list('p1')).pending_sync, ['fast'])
  // acks are per player
  assert.deepEqual(await r.svc.ack('p2', ['fast']), [])
})

test('events: match_end feeds built-in stats and event rules with their filter', async () => {
  const r = await rig()
  const m1 = await r.svc.event('p1', 'match_end', { outcome: 'win', queue: 'quick', status: 'complete' }, 'm1')
  assert.deepEqual(codes(m1), ['first_win'])
  const m2 = await r.svc.event('p1', 'match_end', { outcome: 'win', queue: 'ranked', status: 'complete', rating_after: 2520 }, 'm2')
  assert.deepEqual(codes(m2), ['ranked_win'])
  await r.svc.event('p1', 'match_end', { outcome: 'loss', queue: 'quick' }, 'm3')
  assert.deepEqual(await r.svc.stats('p1'), {
    matches_played: 3, matches_won: 2, matches_lost: 1, ranked_matches_played: 1, ranked_matches_won: 1,
    win_streak_current: 0, win_streak_best: 2, rating_peak: 2520,
  })
  // three wins in a row and five wins
  for (const k of ['m4', 'm5', 'm6']) await r.svc.event('p1', 'match_end', { outcome: 'win', queue: 'quick' }, k)
  const l = await r.svc.list('p1')
  assert.deepEqual(codes(l.achievements.filter(a => a.unlocked)), ['first_win', 'five_wins', 'ranked_win', 'streak_3'])
})

test('events: a key makes the event idempotent (a match counted once)', async () => {
  const r = await rig()
  await r.svc.event('p1', 'match_end', { outcome: 'win', queue: 'quick' }, 'same-match')
  const again = await r.svc.event('p1', 'match_end', { outcome: 'win', queue: 'quick' }, 'same-match')
  assert.deepEqual(again, [])
  assert.equal((await r.svc.stats('p1')).matches_played, 1)
  // the same key for another player is another fact
  await r.svc.event('p2', 'match_end', { outcome: 'loss', queue: 'quick' }, 'same-match')
  assert.equal((await r.svc.stats('p2')).matches_played, 1)
  // void / unknown outcomes change nothing
  await r.svc.event('p1', 'match_end', { outcome: null, queue: 'quick' }, 'void-match')
  assert.equal((await r.svc.stats('p1')).matches_played, 1)
})

test('events: pack_opened keeps the unique card count (max) and unlocks the collector', async () => {
  const r = await rig()
  assert.deepEqual(await r.svc.event('p1', 'pack_opened', { pack_type: 'shop', unique_cards: 3 }, 'o1'), [])
  assert.deepEqual(codes(await r.svc.event('p1', 'pack_opened', { pack_type: 'shop', unique_cards: 4 }, 'o2')), ['collector'])
  await r.svc.event('p1', 'purchase', { provider: 'coins' }, 'b1')
  await r.svc.event('p1', 'reward', { reward_id: 'x' }, 'r1')
  const s = await r.svc.stats('p1')
  assert.deepEqual([s.packs_opened, s.cards_unique, s.purchases, s.rewards_claimed], [2, 4, 1, 1])
})

test('list: secret achievements stay hidden until unlocked, progress is shown, achievements added later are caught up', async () => {
  const r = await rig()
  const before = await r.svc.list('p1')
  const secret = before.achievements.find(a => a.code === 'ranked_win')!
  assert.deepEqual([secret.title.en, secret.description.en, secret.unlocked], ['???', '', false])
  const ten = before.achievements.find(a => a.code === 'ten_levels')!
  assert.deepEqual(ten.progress, { stat: 'levels_done', value: 0, threshold: 10 })
  assert.deepEqual(ten.title, { fr: 'ten_levels fr', en: 'ten_levels en' })
  assert.ok(!before.achievements.some(a => a.code === 'off')) // inactive
  assert.ok(before.achievements.some(a => a.code === 'gm')) // manual is listed, never auto-unlocked
  await r.svc.report('p1', 'o1', 'levels_done', 5)
  // a new achievement whose stat is already reached unlocks at the next list
  await r.ach('five_levels', { rule_stat: 'levels_done', rule_threshold: 5 })
  const after = await r.svc.list('p1')
  assert.ok(after.achievements.find(a => a.code === 'five_levels')!.unlocked)
  assert.ok(after.pending_sync.includes('five_levels'))
  const ranked = await r.svc.event('p1', 'match_end', { outcome: 'win', queue: 'ranked' }, 'm1')
  assert.ok(ranked.some(a => a.code === 'ranked_win'))
  const shown = (await r.svc.list('p1')).achievements.find(a => a.code === 'ranked_win')!
  assert.deepEqual([shown.title.en, shown.unlocked], ['ranked_win en', true])
})

test('definitions: a bad rule filter never breaks the other achievements', async () => {
  const r = await rig()
  await r.ach('broken', { rule_type: 'event', rule_event: 'match_end', rule_filter: 'not a condition' })
  const out = await r.svc.event('p1', 'match_end', { outcome: 'win', queue: 'quick' }, 'm1')
  assert.deepEqual(codes(out), ['first_win'])
})
