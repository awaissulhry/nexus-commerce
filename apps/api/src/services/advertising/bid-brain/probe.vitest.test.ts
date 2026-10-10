/**
 * BID BRAIN BB-21 — switchback probes (probe.ts), pure.
 *
 *   switch     off · shadow (default) · on
 *   schedule   HLLH / LHHL: 12 days, 6 on each arm (budget-neutral: the average bid is the brain's bid exactly, for every
 *              center and amplitude), washouts on the days an arm switches, the orders alternate within a product's day
 *   arms       symmetric in cents; held under the band top, the switch's largest change, the lowest bid and the spend cap;
 *              ±5 % on a protected term; no room under ±4 % or 2¢
 *   picked     only a held keyword with traffic, no override, raise cap, rule, brake, Owner's brake, budget cap, measured
 *              ε, rest or running probe; the least certain products first, then traffic; 2 starts a product a week
 *   a day      the arm recorded; a stop makes the day not count, a Min-bid hour does not; a person's bid, auto-undo's freeze,
 *              an arm outside the limits, the switch, ownership or too few clean days left end it; a rerun changes nothing;
 *              the schedule's end → MEASURING, measured 3 days later
 *   ε          a known ε read back from made-up clicks; the variance widens with over-dispersion; many noisy probes of a
 *              made-up product pool near the truth (productEps); the normal update of the prior; a shadow probe is a
 *              placebo and never a reading; productEps with no probe is exactly as before
 *   flags      shadow returns the very decisions decide made (the golden bytes of __golden__/flag-off.json, written on
 *              origin/main before BB-15); on changes only the armed keywords: layer probe, the step from the center
 *
 * Made-up numbers only (the repository is public).
 */
import { describe, expect, it } from 'vitest'
import { decide, type Decision, type TargetFacts } from './decide.js'
import { weigh, type DayEvidence, type Evidence } from './estimator.js'
import { buildFacts, type AdGroupRow, type CampaignRow, type MarketRows, type RunRows, type StrategyRead, type TargetRow } from './facts.js'
import { EPS_PRIOR, EPS_PRIOR_MEAN, productEps, updateNormal, type EpsReading, type MoveEvent } from './response.js'
import {
  DAILY_EXTRA_CAP_CENTS, MIN_CLEAN_DAYS, PROBE_DAYS, SETTLE_DAYS, addDays, applyProbeArm, applyProbeArms, averageBid, cleanCounts,
  doneWords, endDayOf, finishProbe, isProbeOption, measureProbe, planProbes, probeArms, probeMode, probeOption, probeSummaryWords,
  productModeKey, restKey, scheduleDay, scheduleOf, sequenceFor, stepProbe,
  type DayRow, type PlanLedger, type ProbeArm, type ProbeCandidate, type ProbeOption, type ProbeRecord, type ProbeSkip,
} from './probe.js'

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
/** A Poisson draw (Knuth). */
function poisson(mean: number, r: () => number): number {
  const l = Math.exp(-mean)
  let k = 0
  let p = 1
  do { k++; p *= r() } while (p > l)
  return k - 1
}

/** A keyword with plenty of its own data, in its band at 45¢: a made-up 2.5 % rate, €80 orders, 44¢ a click (22 %). */
const busy = (current = 45, extra: Partial<TargetFacts> = {}): TargetFacts => ({
  targetId: `kw-${current}`, currentCents: current, dataDay: '2026-09-30',
  chain: [{ level: 'target', evidence: ev(600, 15, 120_000, 26_400) }, { level: 'product', evidence: ev(6000, 150, 1_200_000, 264_000) }, { level: 'market', evidence: ev(20_000, 500, 4_000_000, 880_000) }],
  listPriceCents: 8000, servingCents: 45,
  goal: { target: { kind: 'ACOS', pct: 22 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT', breakEvenAcos: 0.35 },
  limits: { maxBidCents: 80, maxChangePct: 25 },
  ...extra,
})

const candidate = (f: TargetFacts, extra: Partial<ProbeCandidate> = {}): ProbeCandidate => ({
  f, d: decide(f), campaignId: 'c1', adGroupId: 'g1', productKey: 'famA', clicks14: 42, eps: EPS_PRIOR, protection: null, capped: false,
  ownerBrake: null, mode: 'SHADOW', ...extra,
})
const emptyLedger: PlanLedger = { active: new Set(), restUntil: new Map(), startsWeek: new Map(), startsToday: new Map() }
const TODAY = '2026-10-01'

const probe = (over: Partial<ProbeRecord> = {}): ProbeRecord => ({
  id: 'bp_1', marketplace: 'IT', campaignId: 'c1', adGroupId: 'g1', targetId: 'kw-45', productKey: 'famA', mode: 'SHADOW', status: 'RUNNING',
  centerCents: 45, highCents: 51, lowCents: 39, amplitude: 0.1333, protection: null, sequence: 'HLLH', startDay: TODAY, endDay: endDayOf('HLLH', TODAY),
  days: {}, observed: null, reading: null, epsPrior: null, epsPosterior: null, why: 'test', stoppedWhy: null, ...over,
})
/** The days before `until` recorded as served, at their arm (the runs of those days set them). */
const servedBefore = (until: string, p: ProbeRecord = probe()): ProbeRecord['days'] =>
  Object.fromEntries(scheduleOf(p.sequence, p.startDay).filter((s) => s.day < until).map((s) => [s.day, { arm: s.arm, bidCents: s.arm === 'H' ? p.highCents : p.lowCents, served: true }]))
/** Every day of the schedule recorded as served, at its arm (a LIVE one found in place). */
const servedAll = (p: ProbeRecord): ProbeRecord => ({
  ...p, days: Object.fromEntries(scheduleOf(p.sequence, p.startDay).map((s) => [s.day, { arm: s.arm, bidCents: s.arm === 'H' ? p.highCents : p.lowCents, served: true, ...(p.mode === 'LIVE' ? { confirmed: true as const } : {}) }])),
})

describe('the switch', () => {
  it('off · shadow (default) · on', () => {
    expect(probeMode(undefined)).toBe('shadow')
    expect(probeMode('')).toBe('shadow')
    expect(probeMode('live')).toBe('shadow')
    expect(probeMode(' OFF ')).toBe('off')
    expect(probeMode('false')).toBe('off')
    expect(probeMode('on')).toBe('on')
    expect(probeMode('1')).toBe('on')
  })
})

describe('the schedule: switchback, trend-balanced, budget-neutral', () => {
  it('HLLH and LHHL: 12 days, 6 on each arm, a washout only where the arm switches', () => {
    for (const seq of ['HLLH', 'LHHL']) {
      const days = scheduleOf(seq, TODAY)
      expect(days).toHaveLength(PROBE_DAYS)
      expect(PROBE_DAYS).toBe(12)
      expect(days.filter((d) => d.arm === 'H')).toHaveLength(6)
      expect(days.filter((d) => d.arm === 'L')).toHaveLength(6)
      // The switches: day 1 (from the brain's bid), day 4 and day 10 — not day 7 (the middle periods share an arm).
      expect(days.filter((d) => d.washout).map((d) => d.index)).toEqual([0, 3, 9])
      // A steady drift cancels: the counted days' mean position is the same on both arms.
      const mean = (arm: string) => { const c = days.filter((d) => d.arm === arm && !d.washout); return c.reduce((s, d) => s + d.index, 0) / c.length }
      expect(Math.abs(mean('H') - mean('L'))).toBeLessThan(1)
    }
    expect(scheduleDay('HLLH', TODAY, addDays(TODAY, -1))).toBeNull()
    expect(scheduleDay('HLLH', TODAY, addDays(TODAY, 12))).toBeNull()
    expect(scheduleDay('HLLH', TODAY, addDays(TODAY, 4))).toMatchObject({ index: 4, period: 1, arm: 'L', washout: false })
    expect(endDayOf('HLLH', TODAY)).toBe('2026-10-12')
  })

  it('the average bid is the brain\'s bid exactly, for any center and amplitude the arms allow', () => {
    const r = rng(7)
    for (let i = 0; i < 300; i++) {
      const center = 6 + Math.floor(r() * 200)
      const arms = probeArms({ centerCents: center, amplitude: 0.02 + r() * 0.2, uppers: [{ cents: center * (1 + r() * 0.3), words: 'a cap' }], lower: { cents: 5, words: 'the floor' }, maxChangePct: 10 + Math.floor(r() * 40) })
      if ('none' in arms) continue
      expect(arms.highCents - center).toBe(center - arms.lowCents)
      for (const seq of ['HLLH', 'LHHL']) expect(averageBid({ sequence: seq, highCents: arms.highCents, lowCents: arms.lowCents })).toBe(center)
    }
  })

  it('one product\'s starts of a day alternate the two orders (half high while half low)', () => {
    const a = sequenceFor('famA', TODAY, 0)
    expect(sequenceFor('famA', TODAY, 1)).not.toBe(a)
    expect(sequenceFor('famA', TODAY, 2)).toBe(a)
    expect(sequenceFor('famA', TODAY, 0)).toBe(a)
  })
})

describe('the arms', () => {
  const base = { centerCents: 45, amplitude: 0.15, uppers: [] as Array<{ cents: number; words: string }>, lower: { cents: 5, words: 'the 5¢ engine floor' }, maxChangePct: 100 }

  it('±15 % symmetric in cents; one switch H ↔ L within the largest change', () => {
    expect(probeArms(base)).toEqual({ deltaCents: 7, highCents: 52, lowCents: 38, amplitude: 0.1556, held: null })
    // 25 %: H → L may move at most 25 % of H, so δ ≤ 45 × 0.25 ÷ 1.75.
    const held = probeArms({ ...base, maxChangePct: 25 })
    expect(held).toMatchObject({ deltaCents: 6, highCents: 51, lowCents: 39, held: 'one switch within the largest change 25%' })
    if (!('none' in held)) expect((held.highCents - held.lowCents) / held.highCents).toBeLessThanOrEqual(0.25)
  })

  it('held under the band top, above the lowest bid, and under the spend cap; ±5 % on a protected term; no room under ±4 % or 2¢', () => {
    expect(probeArms({ ...base, uppers: [{ cents: 49.5, words: 'the band top 28%' }] })).toMatchObject({ highCents: 49, lowCents: 41, held: 'the band top 28%' })
    expect(probeArms({ ...base, lower: { cents: 42, words: 'the strategy lowest bid' } })).toMatchObject({ highCents: 48, lowCents: 42, held: 'the strategy lowest bid' })
    const capped = probeArms({ ...base, extraAt: (d) => d * 20, capCents: DAILY_EXTRA_CAP_CENTS })
    expect(capped).toMatchObject({ deltaCents: 5, held: `the ${DAILY_EXTRA_CAP_CENTS}¢ a day spend cap` })
    expect(probeArms({ ...base, amplitude: 0.05 })).toMatchObject({ deltaCents: 2, highCents: 47, lowCents: 43 })
    expect(probeArms({ ...base, uppers: [{ cents: 46.5, words: 'the band top 28%' }] })).toEqual({ none: 'no room to probe: ±1¢ around 45¢ (held to the band top 28%) is under ±4% or 2¢' })
    expect(probeArms({ ...base, centerCents: 6 })).toEqual({ none: 'no room to probe: ±1¢ around 6¢ is under ±4% or 2¢' })
  })
})

describe('picking keywords', () => {
  it('a held keyword with traffic gets symmetric arms inside the band top, break-even, the limits and the switch\'s largest change', () => {
    const c = candidate(busy())
    expect(c.d).toMatchObject({ layer: 'band', action: 'hold' })
    const o = probeOption(c, emptyLedger, TODAY) as ProbeOption
    expect(isProbeOption(o)).toBe(true)
    expect(o).toMatchObject({ centerCents: 45, highCents: 51, lowCents: 39, held: 'one switch within the largest change 25%', mode: 'SHADOW' })
    expect(o.extraCents).toBeGreaterThan(0)
    expect(o.extraCents).toBeLessThanOrEqual(DAILY_EXTRA_CAP_CENTS)
    // Busier: the high arm's expected extra spend holds δ to the cap.
    const loud = probeOption(candidate(busy(), { clicks14: 280 }), emptyLedger, TODAY) as ProbeOption
    expect(loud.held).toBe(`the ${DAILY_EXTRA_CAP_CENTS}¢ a day spend cap`)
    expect(loud.highCents - 45).toBe(45 - loud.lowCents)
    expect(loud.extraCents).toBeLessThanOrEqual(DAILY_EXTRA_CAP_CENTS)
    // A protected, brand or winner term: ±5 % only.
    expect(probeOption(candidate(busy(), { protection: 'winner' }), emptyLedger, TODAY)).toMatchObject({ highCents: 47, lowCents: 43, protection: 'winner' })
  })

  it('never under an override, a raise cap, a rule, a brake, the Owner\'s brake, a budget cap, thin traffic, a measured ε, a rest, a running probe or a moving goal', () => {
    const why = (c: ProbeCandidate, ledger: Partial<PlanLedger> = {}) => (probeOption(c, { ...emptyLedger, ...ledger }, TODAY) as ProbeSkip).why
    expect(why(candidate(busy(45, { overrides: { stop: { bidCents: 2, by: 'suppress-campaign' } } })))).toBe('the stop layer decides')
    expect(why(candidate(busy(45, { overrides: { pin: { by: 'user:owner' } } })))).toMatch(/^a person's or a held bid \(user:owner\)/)
    expect(why(candidate(busy(45, { overrides: { minBidHour: { floorCents: 3 } } })))).toBe('a Min-bid hour holds its floor')
    expect(why(candidate(busy(45, { overrides: { money: { stepPct: 10, by: 'the money brake' } } })))).toBe('the money layer decides')
    expect(why(candidate(busy(45, { raiseCap: 'the campaign is held by auto-undo' })))).toBe('raises wait (the campaign is held by auto-undo)')
    expect(why(candidate(busy(45, { directives: [{ kind: 'CEILING', cents: 60, source: 'rule:A' }] })))).toBe('a rule\'s ceiling or floor steers it')
    expect(why(candidate(busy(45, { brakes: ['campaign paused'] })))).toBe('a brake (campaign paused)')
    expect(why(candidate(busy(), { ownerBrake: 'excluded by the Owner' }))).toBe('the Owner keeps the brain off its campaign (excluded by the Owner)')
    expect(why(candidate(busy(), { capped: true }))).toBe('budget capped: a raise buys no clicks there')
    expect(why(candidate(busy(), { clicks14: 30 }))).toBe('15 clicks a week (under 20)')
    expect(why(candidate(busy(), { eps: { mean: 0.6, sd: 0.2 } }))).toBe('its product\'s ε is measured (± 0.2)')
    expect(why(candidate(busy()), { restUntil: new Map([[restKey('kw-45', 'SHADOW'), '2026-10-20']]) })).toBe('resting after its last probe until 2026-10-20')
    // The rest of another mode does not hold it.
    expect(isProbeOption(probeOption(candidate(busy()), { ...emptyLedger, restUntil: new Map([[restKey('kw-45', 'LIVE'), '2026-10-20']]) }, TODAY))).toBe(true)
    expect(why(candidate(busy()), { active: new Set(['kw-45']) })).toBe('in a probe already')
    // A keyword the goal still moves is no clean base.
    expect(why(candidate(busy(25)))).toBe('the goal still moves it (no clean base)')
  })

  it('the least certain products first, then the busiest keywords; 2 starts a product a week; a product\'s starts alternate', () => {
    const opt = (targetId: string, productKey: string, epsSd: number, clicks14: number): ProbeOption => ({
      targetId, campaignId: 'c1', adGroupId: 'g1', productKey, mode: 'SHADOW', centerCents: 45, highCents: 51, lowCents: 39, amplitude: 0.13,
      protection: null, clicks14, epsSd, eps: { mean: 0.8, sd: epsSd }, extraCents: 40, held: null,
    })
    const items = [opt('a1', 'A', 0.3, 50), opt('b1', 'B', 0.4, 40), opt('b2', 'B', 0.4, 90), opt('b3', 'B', 0.4, 60), opt('a2', 'A', 0.3, 80), { targetId: 'x', why: 'thin' }]
    const { started, capped } = planProbes(items, { startsWeek: new Map([[productModeKey('A', 'SHADOW'), 1]]), startsToday: new Map() }, TODAY)
    expect(started.map((p) => p.targetId)).toEqual(['b2', 'b3', 'a2'])
    expect(capped.map((p) => p.targetId)).toEqual(['b1', 'a1'])
    expect(capped[0].why).toBe('its product started 2 probes in 7 days (at most 2)')
    expect(started[0].sequence).not.toBe(started[1].sequence)
    expect(started.every((p) => p.startDay === TODAY && p.endDay === '2026-10-12')).toBe(true)
    expect(started[0].why).toMatch(/^ε of its product 0\.8 ± 0\.4 is the least certain it may test; 45 clicks a week; ±6¢ \(13%\) around 45¢, high days \+40¢ expected at most$/)
  })
})

describe('a running probe, run by run', () => {
  const f = busy()
  const d = decide(f)
  const at = (n: number) => addDays(TODAY, n)

  it('records the day\'s arm; a rerun on the same facts changes nothing; a LIVE probe\'s arm stands in under on; a day with no run does not count', () => {
    const p = probe({ mode: 'LIVE' })
    const s1 = stepProbe({ p, today: at(1), f, d, known: true, mode: 'on', owned: true })
    expect(s1).toMatchObject({ changed: true, arm: { bidCents: 51, arm: 'H', index: 1, washout: false }, measure: false })
    expect(s1.next.days[at(1)]).toEqual({ arm: 'H', bidCents: 51, served: true })
    expect(s1.note).toBe('probe: day 2 of 12, the high arm (45¢ + 6¢); switchback HLLH from 2026-10-01, budget-neutral: 6 days at 51¢ and 6 at 39¢, average 45¢')
    // The next run finds the arm in place: the day is confirmed (only a confirmed LIVE day counts); a third run changes nothing.
    const f51 = busy(51)
    const s2 = stepProbe({ p: s1.next, today: at(1), f: f51, d: decide(f51), known: true, mode: 'on', owned: true })
    expect(s2).toMatchObject({ changed: true, arm: { bidCents: 51 } })
    expect(s2.next.days[at(1)]).toEqual({ arm: 'H', bidCents: 51, served: true, confirmed: true })
    expect(stepProbe({ p: s2.next, today: at(1), f: f51, d: decide(f51), known: true, mode: 'on', owned: true })).toMatchObject({ changed: false, arm: { bidCents: 51 } })
    // A run that finds the arm missing after one set it that day (a write refused, deferred or clamped): the day does not count; the arm is asked again.
    const missing = stepProbe({ p: s1.next, today: at(1), f, d, known: true, mode: 'on', owned: true })
    expect(missing.next.days[at(1)]).toEqual({ arm: 'H', bidCents: 51, served: false, yielded: 'the arm 51¢ was not in place at a later run (45¢: a write refused, deferred or clamped)' })
    expect(missing.arm).toMatchObject({ bidCents: 51 })
    // Shadow: the same record, and words that say what it would bid; no arm stands in.
    const sh = stepProbe({ p: probe({ days: servedBefore(at(4)) }), today: at(4), f, d, known: true, mode: 'shadow', owned: false })
    expect(sh.next.days[at(4)]).toEqual({ arm: 'L', bidCents: 39, served: true })
    expect(sh.note).toMatch(/^probe \(shadow\): would bid 39¢ — day 5 of 12, the low arm \(45¢ − 6¢\)/)
    // Days 2–4 with no run: the high side can no longer reach 3 clean days (days 11 and 12 to come).
    expect(stepProbe({ p: probe(), today: at(4), f, d, known: true, mode: 'shadow', owned: false }).next).toMatchObject({
      status: 'STOPPED', stoppedWhy: 'too few clean days left (high 0 + 2 to come, low 1 + 4; 3 a side needed)',
    })
  })

  it('a stop makes the day not count; a Min-bid hour does not; a person\'s bid or auto-undo\'s freeze ends it', () => {
    const stopF = busy(45, { overrides: { stop: { bidCents: 2, by: 'suppress-campaign' } } })
    const stopped = stepProbe({ p: probe({ days: servedBefore(at(4)) }), today: at(4), f: stopF, d: decide(stopF), known: true, mode: 'shadow', owned: false })
    expect(stopped.next.days[at(4)]).toEqual({ arm: 'L', bidCents: 39, served: false, yielded: 'the stop layer decides' })
    expect(stopped.arm).toBeNull()
    expect(stopped.note).toBe('probe (shadow): day 5 of 12 does not count — the stop layer decides')
    // A later run of the same day that could set the arm leaves the day not counted.
    expect(stepProbe({ p: stopped.next, today: at(4), f, d, known: true, mode: 'shadow', owned: false }).next.days[at(4)]).toMatchObject({ served: false })
    const minF = busy(45, { overrides: { minBidHour: { floorCents: 3 } } })
    const floored = stepProbe({ p: probe({ days: servedBefore(at(4)) }), today: at(4), f: minF, d: decide(minF), known: true, mode: 'shadow', owned: false })
    expect(floored.next.days[at(4)]).toEqual({ arm: 'L', bidCents: 39, served: true, minBid: true })
    expect(floored.note).toBe('probe (shadow): day 5 of 12 still counts — a Min-bid hour holds its floor for its hours')
    const pinF = busy(45, { overrides: { pin: { by: 'user:owner' } } })
    expect(stepProbe({ p: probe(), today: at(4), f: pinF, d: decide(pinF), known: true, mode: 'shadow', owned: false }).next).toMatchObject({ status: 'STOPPED', stoppedWhy: 'a person\'s or a held bid (user:owner) — it stands' })
    const frozen = busy(45, { overrides: { freeze: { by: 'auto-undo' } } })
    expect(stepProbe({ p: probe(), today: at(4), f: frozen, d: decide(frozen), known: true, mode: 'shadow', owned: false }).next).toMatchObject({ status: 'STOPPED', stoppedWhy: 'auto-undo froze the campaign (auto-undo)' })
  })

  it('ends on an arm outside today\'s limits, the switch, the brain\'s ownership, a lost keyword, or too few clean days left', () => {
    const lowMax = busy(45, { limits: { maxBidCents: 50, maxChangePct: 25 } })
    expect(stepProbe({ p: probe(), today: at(1), f: lowMax, d: decide(lowMax), known: true, mode: 'shadow', owned: false }).next.stoppedWhy).toBe('the high arm 51¢ is above the strategy highest bid 50¢ now')
    expect(stepProbe({ p: probe({ mode: 'LIVE' }), today: at(1), f, d, known: true, mode: 'shadow', owned: true }).next.stoppedWhy).toBe('the switch is no longer on')
    expect(stepProbe({ p: probe({ mode: 'LIVE' }), today: at(1), f, d, known: true, mode: 'on', owned: false }).next.stoppedWhy).toBe('the brain no longer owns the campaign')
    expect(stepProbe({ p: probe(), today: at(1), f, d, known: true, mode: 'on', owned: true }).next.stoppedWhy).toBe('the switch went on: a live probe takes over')
    expect(stepProbe({ p: probe(), today: at(1), known: false, mode: 'shadow', owned: false }).next.status).toBe('STOPPED')
    // Another run's keyword: left as it is.
    expect(stepProbe({ p: probe(), today: at(1), known: true, mode: 'shadow', owned: false })).toMatchObject({ changed: false, note: null })
    // Days 2–3 (high) missed and day 11 to come: the high side cannot reach 3 clean days.
    const lost = probe({ days: { [at(1)]: { arm: 'H', bidCents: 51, served: false, yielded: 'x' }, [at(2)]: { arm: 'H', bidCents: 51, served: false, yielded: 'x' } } })
    const stopF = busy(45, { overrides: { stop: { bidCents: 2, by: 'suppress-campaign' } } })
    const end = stepProbe({ p: { ...lost, days: { ...lost.days, [at(10)]: { arm: 'H', bidCents: 51, served: false, yielded: 'x' } } }, today: at(10), f: stopF, d: decide(stopF), known: true, mode: 'shadow', owned: false })
    expect(end.next).toMatchObject({ status: 'STOPPED' })
    expect(end.next.stoppedWhy).toMatch(/^too few clean days left \(high 0 \+ 1 to come, low 0 \+ 0 to come|^too few clean days left/)
    expect(cleanCounts(servedAll(probe()), at(11))).toEqual({ H: { clean: 4, toCome: 0 }, L: { clean: 5, toCome: 0 } })
  })

  it('after its last day: MEASURING, and measured 3 days later', () => {
    const done = servedAll(probe())
    const s = stepProbe({ p: done, today: at(12), f, d, known: true, mode: 'shadow', owned: false })
    expect(s).toMatchObject({ changed: true, measure: false, next: { status: 'MEASURING' } })
    expect(stepProbe({ p: s.next, today: at(11 + SETTLE_DAYS), known: false, mode: 'off', owned: false })).toMatchObject({ changed: false, measure: false })
    expect(stepProbe({ p: s.next, today: at(12 + SETTLE_DAYS), known: false, mode: 'off', owned: false })).toMatchObject({ measure: true })
  })
})

describe('ε from a probe, and its update', () => {
  /** The days of a probe with clicks at `rate(arm)` a day (no noise unless `r`). */
  const daily = (p: ProbeRecord, rate: (arm: 'H' | 'L') => number, r?: () => number): Map<string, DayRow> =>
    new Map(scheduleOf(p.sequence, p.startDay).map((s) => {
      const mean = rate(s.arm)
      const clicks = r ? poisson(mean, r) : mean
      return [s.day, { clicks, impressions: clicks * 30, costCents: clicks * (s.arm === 'H' ? 46 : 35), orders: clicks * 0.025 }]
    }))

  it('reads a known ε back from made-up clicks, with the quasi-Poisson variance', () => {
    const p = servedAll(probe({ mode: 'LIVE', highCents: 115, lowCents: 85, centerCents: 100 }))
    const truth = 0.8
    const m = measureProbe(p, daily(p, (a) => 40 * Math.pow((a === 'H' ? 115 : 85) / 100, truth)), '2026-10-16')
    expect(m.enough).toBe(true)
    expect(m.observed).toMatchObject({ H: { days: 4 }, L: { days: 5 }, washout: 3, notCounted: 0, dispersion: 1 })
    expect(m.reading!.eps).toBeCloseTo(truth, 1)
    const lb = Math.log(115 / 85)
    expect(m.reading!.variance).toBeCloseTo((1 / (m.observed.H.clicks + 0.5) + 1 / (m.observed.L.clicks + 0.5)) / (lb * lb), 3)
    // Over-dispersed days widen it.
    const wobbly = new Map([...daily(p, () => 40)].map(([day, r], i) => [day, { ...r, clicks: i % 2 ? 20 : 60 }]))
    const w = measureProbe(p, wobbly, '2026-10-16')
    expect(w.observed.dispersion).toBeGreaterThan(5)
    expect(w.reading!.variance).toBeGreaterThan(m.reading!.variance * 5)
  })

  it('many noisy probes of a made-up product with ε 0.6 pool near 0.6; a few stay near the prior', () => {
    const r = rng(21)
    const readings: EpsReading[] = []
    for (let i = 0; i < 40; i++) {
      const p = servedAll(probe({ mode: 'LIVE', sequence: i % 2 ? 'HLLH' : 'LHHL', highCents: 115, lowCents: 85, centerCents: 100 }))
      const base = 20 + r() * 40
      const m = measureProbe(p, daily(p, (a) => base * Math.pow((a === 'H' ? 115 : 85) / 100, 0.6), r), '2026-10-16')
      if (m.reading) readings.push(m.reading)
    }
    const pooled = productEps(new Map(), 'jacket', EPS_PRIOR, new Map([['jacket', readings]]))
    expect(pooled.mean).toBeGreaterThan(0.45)
    expect(pooled.mean).toBeLessThan(0.75)
    expect(pooled.measured).toBe(true)
    expect(pooled).toMatchObject({ ownProbes: 40, marketProbes: 0, from: '40 probes of its product' })
    const few = productEps(new Map(), 'jacket', EPS_PRIOR, new Map([['jacket', readings.slice(0, 1)]]))
    expect(Math.abs(few.mean - EPS_PRIOR_MEAN)).toBeLessThan(0.4)
    // Another product's probes teach the market, not the product's own count.
    const other = productEps(new Map(), 'gloves', EPS_PRIOR, new Map([['jacket', readings]]))
    expect(other).toMatchObject({ ownProbes: 0, marketProbes: 40, from: '40 probes in the market' })
    expect(other.mean).toBeLessThan(EPS_PRIOR_MEAN)
  })

  it('productEps with no probe is exactly as before; with moves and probes it says both', () => {
    const moves = new Map<string | null, MoveEvent[]>([['jacket', [{ targetId: 'kw', productKey: 'jacket', beforeCents: 20, afterCents: 25, days: 7, clicksBefore: 100, clicksAfter: 120, control: null }]]])
    expect(productEps(moves, 'jacket', EPS_PRIOR, new Map())).toEqual(productEps(moves, 'jacket'))
    expect(productEps(new Map(), 'jacket', EPS_PRIOR, new Map())).toEqual(productEps(new Map(), 'jacket'))
    expect(productEps(moves, 'jacket', EPS_PRIOR, new Map([['jacket', [{ eps: 0.5, variance: 0.04 }]]])).from).toBe('1 probe of its product, 1 move of its product')
  })

  it('the update: a normal update of the posterior the run found; DONE with what it observed', () => {
    const p = servedAll(probe({ mode: 'LIVE', highCents: 115, lowCents: 85, centerCents: 100 }))
    const m = measureProbe(p, daily(p, (a) => (a === 'H' ? 50 : 40)), '2026-10-16')
    const done = finishProbe(p, m, { mean: 0.8, sd: 0.4 })
    const want = updateNormal({ mean: 0.8, sd: 0.4 }, m.reading!)
    expect(done).toMatchObject({ status: 'DONE', epsPrior: { mean: 0.8, sd: 0.4 } })
    expect(done.epsPosterior!.mean).toBeCloseTo(want.mean, 3)
    expect(done.epsPosterior!.sd).toBeCloseTo(want.sd, 3)
    expect(done.epsPosterior!.sd).toBeLessThan(0.4)
    expect(doneWords(done)).toMatch(/^probe: done — ε [\d.]+ ± [\d.]+ \(high 115¢: 50 clicks a day over 4 days, low 85¢: 40 over 5, dispersion 1\); its product's ε 0\.8 ± 0\.4 → [\d.]+ ± [\d.]+$/)
    // The textbook case: prior N(0.8, 0.4), a reading 0.5 with variance 0.04 → 0.56 ± 0.18.
    const book = updateNormal({ mean: 0.8, sd: 0.4 }, { eps: 0.5, variance: 0.04 })
    expect(book.mean).toBeCloseTo(0.56, 6)
    expect(book.sd).toBeCloseTo(Math.sqrt(1 / 31.25), 6)
  })

  it('a shadow probe is a placebo: observed, never a reading; too few clean days → STOPPED', () => {
    const p = servedAll(probe())
    const m = measureProbe(p, daily(p, () => 40), '2026-10-16')
    expect(m.reading).toBeNull()
    const done = finishProbe(p, m, EPS_PRIOR)
    expect(done).toMatchObject({ status: 'DONE', reading: null, epsPosterior: null })
    expect(doneWords(done)).toBe('probe (shadow): done — a placebo (both arms served the same bid): high 51¢: 40 clicks a day over 4 days, low 39¢: 40 over 5, ratio 1 (1 expected); no ε reading')
    const thin = { ...p, days: Object.fromEntries(Object.entries(p.days).map(([day, x], i) => [day, { ...x, served: i > 7 }])) }
    const stopped = finishProbe(thin, measureProbe(thin, daily(thin, () => 40), '2026-10-16'), EPS_PRIOR)
    expect(stopped.status).toBe('STOPPED')
    expect(stopped.stoppedWhy).toMatch(new RegExp(`^too few clean days \\(high \\d, low \\d; ${MIN_CLEAN_DAYS} a side needed\\)$`))
  })
})

describe('the run line', () => {
  it('says what ran', () => {
    expect(probeSummaryWords(null)).toBe('')
    expect(probeSummaryWords({ mode: 'shadow', running: 3, live: 0, started: 1, armed: 0, measuring: 1, done: 1, stopped: 0 })).toBe('probes (shadow): 3 running (1 new), 1 measuring, 1 done')
    expect(probeSummaryWords({ mode: 'on', running: 2, live: 2, started: 0, armed: 2, measuring: 0, done: 0, stopped: 1 })).toBe('probes: 2 running, 2 live, 2 arms set, 1 stopped')
  })
})

// ── The golden: the generators below are byte-for-byte golden-flag-off.vitest.test.ts's (BB-15). ──

/** A small deterministic generator (mulberry32): the same seed, the same spread, on every machine. */
const goldenRng = rng

const campaign = (id: string, extra: Partial<CampaignRow> = {}): CampaignRow => ({
  id, status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null,
  minBidCents: null, maxBidCents: null, ownTargetAcos: undefined, allowlisted: true, ...extra,
})
const group = (id: string, campaignId: string, families: string[], extra: Partial<AdGroupRow> = {}): AdGroupRow => ({
  id, campaignId, status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families, productIds: families, ...extra,
})
const strategy = (pct: number, extra: Partial<StrategyRead> = {}): StrategyRead => ({
  target: { kind: 'ACOS', pct }, acosPct: pct, band: null, goal: 'PROFIT', minBidCents: null, maxBidCents: 90, maxChangePct: 25, ...extra,
})

/** One seeded market: 4 campaigns (one not allowlisted), 8 ad groups over 3 families, 6 keywords each. */
function seededMarket(seed: number): { m: MarketRows; run: RunRows } {
  const r = goldenRng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const campaigns = new Map<string, CampaignRow>([
    ['c1', campaign('c1')],
    ['c2', campaign('c2', { ownTargetAcos: 0.3 })],
    ['c3', campaign('c3', { minBidCents: 8, maxBidCents: 60 })],
    ['c4', campaign('c4', { allowlisted: false })],
  ])
  const families = ['famA', 'famB', 'famC']
  const adGroups = new Map<string, AdGroupRow>()
  for (let g = 1; g <= 8; g++) adGroups.set(`g${g}`, group(`g${g}`, `c${((g - 1) % 4) + 1}`, [families[(g - 1) % 3]]))
  const words = ['race jacket', 'leather jacket', 'boots', 'gloves', 'helmet', 'back protector', 'rain suit', 'knee slider']
  const targets: TargetRow[] = []
  const evidence = new Map<string, Evidence>()
  for (const [gid] of adGroups) {
    for (let k = 0; k < 6; k++) {
      const id = `${gid}-t${k}`
      targets.push({ id, adGroupId: gid, kind: 'KEYWORD', expressionType: pick(['EXACT', 'PHRASE', 'BROAD']), expressionValue: pick(words), bidCents: 5 + Math.floor(r() * 60), suppressedFromBidCents: r() < 0.05 ? 40 : null })
      const clicks = Math.floor(r() * r() * 400)
      const orders = Math.floor(clicks * r() * 0.04)
      evidence.set(id, { clicks: clicks * (0.6 + r() * 0.4), orders: orders * (0.6 + r() * 0.4), salesCents: orders * (6000 + Math.floor(r() * 4000)), costCents: clicks * (15 + Math.floor(r() * 30)) })
    }
  }
  const m: MarketRows = {
    market: 'IT', dataDay: '2026-10-01', campaigns, adGroups, targets, evidence,
    adSales30: new Map(targets.map((t) => [t.id, Math.floor(r() * 20_000)])),
    prices: new Map([['famA', 9000], ['famB', 4500]]),
  }
  const run: RunRows = {
    marketBrakes: [],
    strategy: new Map([
      ['g1', strategy(20, { band: { loPct: 18, hiPct: 28 } })],
      ['g2', strategy(25)],
      ['g3', strategy(15, { goal: 'GROW', minBidCents: 10 })],
      ['g5', { ...strategy(10), target: { kind: 'TACOS', pct: 10 }, acosPct: 22, band: { loPct: 8, hiPct: 14 } }],
      ['g6', strategy(30, { maxChangePct: 50 })],
      ['g7', strategy(20, { goal: 'LAUNCH', launchDay: 3 })],
    ]),
    accountDefaultPct: 25,
    personHeld: new Set(['g2-t1']),
    holds: [{ campaignId: 'c3', targetId: 'g3-t2', kind: 'PIN', by: 'user:owner', until: new Date('2026-12-01T00:00:00Z') }],
    enrollments: new Map([['c2', { mode: 'HELD', heldBy: 'auto-undo', heldUntil: new Date('2026-10-20T00:00:00Z') }]]),
    lastSteps: new Map([['g1-t0', { dataDay: '2026-10-01', fromCents: 30, toCents: targets[0].bidCents }]]),
    familySales: new Map([['famA', 400_000], ['famB', 90_000]]),
    stock: new Map([['g6', { kind: 'lowCover', factor: 0.7, by: 'low stock: 5 days of cover against a 14-day line' }]]),
    breakEven: new Map([['g1', 0.35], ['g7', 0.3]]),
    lowered: new Map([['g5-t3', { layer: 'stop', heldCents: targets.find((t) => t.id === 'g5-t3')!.bidCents, beforeCents: 33 }]]),
    directives: new Map([['c1', [{ targetId: null, lane: null, kind: 'CEILING', valueCents: 45, valuePct: null, label: 'rule "ceiling"' }]]]),
  }
  return { m, run }
}

/** Worked-example facts in the shape of the decide test's (§7), on a made-up 1 % rate, at a spread of bids and steps. */
function workedExamples(): TargetFacts[] {
  const base = (current: number, extra: Partial<TargetFacts> = {}): TargetFacts => ({
    targetId: `kw-${current}`, currentCents: current, dataDay: '2026-09-29',
    chain: [{ level: 'target', evidence: ev(1, 0, 0, 30) }, { level: 'product', evidence: ev(2000, 20, 160_000, 60_000) }, { level: 'market', evidence: ev(9000, 90, 720_000, 270_000) }],
    listPriceCents: 9000, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 },
    ...extra,
  })
  const out: TargetFacts[] = []
  for (const c of [3, 8, 14, 16, 19, 22, 25, 33, 45, 60, 90]) out.push(base(c))
  out.push(base(25, { lastStep: { dataDay: '2026-09-29', fromCents: 33, toCents: 25 } }))
  out.push(base(33, { overrides: { stop: { bidCents: 2, by: 'suppress-campaign' }, pin: { by: 'user:owner' } } }))
  out.push(base(33, { overrides: { stock: { coverFactor: 0.5, by: 'stock cover' }, minBidHour: { floorCents: 3 } } }))
  out.push(base(10, { overrides: { freeze: { by: 'auto-undo' } } }))
  out.push(base(2, { restore: { layer: 'stop', heldCents: 2, beforeCents: 30 } }))
  out.push(base(14, { lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 300, maxCpcCents: 55 }, { lane: 'PRODUCT_PAGE', planPct: 50, maxCpcCents: null }] }))
  out.push(base(14, { directives: [{ kind: 'CEILING', cents: 12, source: 'rule:A' }, { kind: 'FLOOR', cents: 15, source: 'rule:B' }] }))
  out.push(base(16, { chain: [{ level: 'target', evidence: ev(120, 6, 48_000, 1680) }, { level: 'product', evidence: ev(2000, 20, 160_000, 60_000) }], limits: { maxChangePct: 100 } }))
  out.push(base(20, { raiseCap: 'the campaign is held by auto-undo' }))
  return out
}

/** Days for `weigh`: a 120-day spread, some past the window. */
function seededDays(seed: number): DayEvidence[] {
  const r = goldenRng(seed)
  return Array.from({ length: 120 }, (_, i) => ({ daysAgo: i - 2, clicks: Math.floor(r() * 30), orders: Math.floor(r() * 2), salesCents: Math.floor(r() * 9000), costCents: Math.floor(r() * 900) }))
}

/**
 * The probes' pipeline over one market's decisions, as the store runs it: every held keyword a candidate (made-up traffic,
 * the prior ε, a LIVE probe where the campaign is c1 and the switch is on), today's plan, each new probe's first day.
 */
function probePipeline(facts: readonly TargetFacts[], decisions: readonly Decision[], mode: 'shadow' | 'on') {
  const candidates = facts.map((f, i): ProbeCandidate => ({
    f, d: decisions[i], campaignId: f.targetId.startsWith('g1-') || f.targetId.startsWith('g5-') ? 'c1' : 'c2', adGroupId: f.targetId.split('-')[0],
    productKey: 'fam', clicks14: 200, eps: EPS_PRIOR, protection: null, capped: false, ownerBrake: null,
    mode: mode === 'on' ? 'LIVE' : 'SHADOW',
  }))
  const { started } = planProbes(candidates.map((c) => probeOption(c, emptyLedger, '2026-10-02')), { startsWeek: new Map(), startsToday: new Map() }, '2026-10-02')
  const byId = new Map(candidates.map((c) => [c.f.targetId, c]))
  const arms = new Map<string, ProbeArm>()
  for (const o of started) {
    const c = byId.get(o.targetId)!
    const p: ProbeRecord = { ...probe(), ...o, id: `bp-${o.targetId}`, marketplace: 'IT', status: 'RUNNING', days: {}, observed: null, reading: null, epsPrior: null, epsPosterior: null, stoppedWhy: null }
    const s = stepProbe({ p, today: '2026-10-02', f: c.f, d: c.d, known: true, mode, owned: o.mode === 'LIVE' })
    if (s.arm && o.mode === 'LIVE') arms.set(o.targetId, { p: s.next, bidCents: s.arm.bidCents, words: s.note!.replace(/^probe: /, '') })
  }
  return { started, arms, out: applyProbeArms(decisions, facts, arms, mode) }
}

describe('the flags: shadow decides exactly as before; on changes only the armed keywords', () => {
  it('shadow: the very decisions decide made, byte for byte the golden recorded on origin/main before BB-15', async () => {
    let planned = 0
    const golden = {
      weigh: [11, 12, 13].map((s) => [weigh(seededDays(s)), weigh(seededDays(s), { windowDays: 14 }), weigh(seededDays(s), { halfLifeDays: 10 })]),
      markets: [101, 202, 303, 404, 505].map((s) => {
        const { m, run } = seededMarket(s)
        const facts = buildFacts(m, run)
        const decisions = facts.map((f) => decide(f))
        const { out, started } = probePipeline(facts, decisions, 'shadow')
        planned += started.length
        expect(out).toBe(decisions)
        return { facts: facts.length, decisions: out }
      }),
      worked: (() => {
        const facts = workedExamples()
        const decisions = facts.map((f) => decide(f))
        const { out } = probePipeline(facts, decisions, 'shadow')
        expect(out).toBe(decisions)
        return out
      })(),
    }
    // Probes were planned (the pipeline ran), and still nothing moved.
    expect(planned).toBeGreaterThan(0)
    // Bid-page fix 10-10 — a floor's give-back and a give-back's bid before are told beside the decision, not part of it: left out of the bytes.
    await expect(JSON.stringify(golden, (key, value) => (key === 'giveBack' || key === 'restoreBeforeCents' ? undefined : value), 1)).toMatchFileSnapshot('./__golden__/flag-off.json')
  })

  it('on: an armed keyword becomes layer probe at its arm, the step from the center, the goal\'s why in brackets; the rest are the same objects', () => {
    let armed = 0
    for (const s of [101, 202, 303, 404, 505]) {
      const { m, run } = seededMarket(s)
      const facts = buildFacts(m, run)
      const decisions = facts.map((f) => decide(f))
      const { out, arms } = probePipeline(facts, decisions, 'on')
      out.forEach((d, i) => {
        const a = arms.get(d.targetId)
        if (!a) { expect(d).toBe(decisions[i]); return }
        armed += 1
        expect(d).toMatchObject({ layer: 'probe', bidCents: a.bidCents, action: a.bidCents !== d.currentCents ? 'write' : 'hold', step: { dataDay: d.dataDay, fromCents: a.p.centerCents, toCents: a.bidCents } })
        expect(d.why).toBe(`probe: ${a.words} (goal: ${decisions[i].why})`)
      })
    }
    expect(armed).toBeGreaterThan(0)
  })

  it('applyProbeArm measures the placements at the arm', () => {
    const f = busy(45, { lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 300, maxCpcCents: 150 }] })
    const d = decide(f)
    const a = applyProbeArm(d, f, { centerCents: 45 }, { bidCents: 51 }, 'day 2 of 12')
    expect(a).toMatchObject({ layer: 'probe', action: 'write', bidCents: 51, step: { dataDay: '2026-09-30', fromCents: 45, toCents: 51 } })
    expect(a.placements[0]).toMatchObject({ lane: 'TOP_OF_SEARCH', planPct: 300, pct: 194 })
  })
})
