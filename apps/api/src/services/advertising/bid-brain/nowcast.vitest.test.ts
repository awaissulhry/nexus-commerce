/**
 * BID BRAIN BB-15 — the nowcast (nowcast.ts, estimator.ts matureSum / weigh with maturity).
 *
 *   switch     NEXUS_BID_BRAIN_NOWCAST: shadow by default (decisions unchanged), off, on; anything else is shadow
 *   maturity   a copy at maturity m counts m of its clicks and cost, its orders as observed, its sales nowcast: the
 *              conversion rate is unbiased, order value and paid CPC per click keep their meaning
 *   young      zero orders on a young day barely move the rate (worth m of its clicks); young days carry at most 30 %
 *              of a keyword's matured clicks and never stand alone; a copy below 40 % is left out (the cap)
 *   identity   with every copy settled and no young day the nowcast is the settled sum, and the brain decides the same
 *   compare    the same decision → no words; a different one → "nowcast to …: would write …" and the counts
 *
 * Made-up numbers only (the repository is public).
 */
import { describe, expect, it } from 'vitest'
import { decide, type Decision, type TargetFacts } from './decide.js'
import { estimate, matureSum, weigh, YOUNG_SHARE_MAX, type DayEvidence, type Evidence, type MaturityOf } from './estimator.js'
import { buildFacts, type MarketRows, type RunRows } from './facts.js'
import { LAG_AGES, maturityOf, priorShares, type LagShares } from './lag-curve.js'
import { compareNowcast, nowcastEvidence, nowcastLastSteps, nowcastMode, nowcastNote, nowcastOnNotes, nowcastSummaryWords, runForRows, youngPctOf, type NowcastGroup } from './nowcast.js'

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
/** L(0) = 60 % for orders, 50 % for sales; full from age 7. */
const SHARES: LagShares = {
  orders: [0.6, 0.8, 0.9, 0.95, 0.97, 0.99, 0.995, ...Array(LAG_AGES - 7).fill(1)],
  sales: [0.5, 0.75, 0.88, 0.94, 0.97, 0.99, 0.995, ...Array(LAG_AGES - 7).fill(1)],
}
const M = maturityOf(SHARES)
const ONES: MaturityOf = () => ({ orders: 1, sales: 1 })

describe('the switch', () => {
  it('is shadow by default and for anything it does not know; off and on only when said', () => {
    expect(nowcastMode(undefined)).toBe('shadow')
    expect(nowcastMode('')).toBe('shadow')
    expect(nowcastMode('shadow')).toBe('shadow')
    expect(nowcastMode('maybe')).toBe('shadow')
    expect(nowcastMode('off')).toBe('off')
    expect(nowcastMode(' OFF ')).toBe('off')
    expect(nowcastMode('false')).toBe('off')
    expect(nowcastMode('on')).toBe('on')
    expect(nowcastMode('ON')).toBe('on')
    // The brain's own switch word is not this one's: still shadow.
    expect(nowcastMode('live')).toBe('shadow')
  })
})

describe('maturity-weighted evidence', () => {
  it('counts a copy with m of its clicks and cost, its orders as observed, its sales nowcast', () => {
    const m = matureSum([{ ...ev(100, 3, 30_000, 2_500), pullAge: 0, young: true }, { ...ev(1000, 10, 100_000, 25_000), pullAge: 7 }], M)
    expect(m.clicks).toBeCloseTo(1000 + 60)
    expect(m.costCents).toBeCloseTo(25_000 + 1_500)
    expect(m.orders).toBeCloseTo(13)
    // 30,000 observed at a 50 % sales share → 60,000 nowcast, weighed by the orders' 60 %: 36,000.
    expect(m.salesCents).toBeCloseTo(100_000 + 36_000)
    expect(m.youngShare).toBeCloseTo(60 / 1060)
    expect(m.youngCapped).toBe(0)
    // The paid CPC per click is untouched (25¢ on both days).
    expect(m.costCents / m.clicks).toBeCloseTo(25)
  })

  it('is unbiased: a young day holding its expected share leaves the rate where it is; read as final it would not', () => {
    // 1 % conversion. The young day had 100 clicks → 1 order in the end, 0.6 of it known at age 0.
    const nowcast = matureSum([{ ...ev(1000, 10), pullAge: 7 }, { ...ev(100, 0.6), pullAge: 0, young: true }], M)
    expect(nowcast.orders / nowcast.clicks).toBeCloseTo(0.01, 10)
    const naive = matureSum([{ ...ev(1000, 10), pullAge: 7 }, { ...ev(100, 0.6), pullAge: 7, young: true }], M)
    expect(naive.orders / naive.clicks).toBeLessThan(0.0097)
  })

  it('zero orders on a young day barely move the estimate (it is worth L(a) of its clicks)', () => {
    const chain = (e: Evidence) => estimate([{ level: 'target', evidence: e }, { level: 'market', evidence: ev(20_000, 200, 1_600_000) }]).node.cr
    const before = chain(matureSum([{ ...ev(200, 4, 32_000), pullAge: 7 }], M))
    const nowcast = chain(matureSum([{ ...ev(200, 4, 32_000), pullAge: 7 }, { ...ev(30, 0), pullAge: 0, young: true }], M))
    const asFinal = chain(matureSum([{ ...ev(200, 4, 32_000), pullAge: 7 }, { ...ev(30, 0), pullAge: 7, young: true }], M))
    expect(nowcast).toBeLessThan(before)
    expect(before - nowcast).toBeLessThan((before - asFinal) * 0.65)
  })

  it('leaves out a copy too young to nowcast (below 40 %), and reads a copy without a pull age as settled', () => {
    const young = maturityOf({ orders: [0.3, ...SHARES.orders.slice(1)], sales: SHARES.sales })
    const m = matureSum([{ ...ev(500, 5), pullAge: 9 }, { ...ev(50, 0), pullAge: 0, young: true }, { ...ev(40, 1) }], young)
    expect(m.tooYoung).toBe(50)
    expect(m.clicks).toBeCloseTo(540)
    expect(m.orders).toBeCloseTo(6)
  })

  it('lets young days carry at most 30 % of a keyword’s matured clicks, and never stand alone', () => {
    const surge = matureSum([{ ...ev(70, 1), pullAge: 7 }, { ...ev(500, 10, 50_000, 10_000), pullAge: 1, young: true }], M)
    expect(surge.youngShare).toBeCloseTo(YOUNG_SHARE_MAX, 10)
    expect(surge.clicks).toBeCloseTo(100)
    // Scaled together: 30 matured young clicks of 400 → 10 orders × 30/400.
    expect(surge.orders).toBeCloseTo(1 + 10 * (30 / 400))
    expect(surge.youngCapped).toBeCloseTo(370)
    const alone = matureSum([{ ...ev(80, 2), pullAge: 0, young: true }], M)
    expect([alone.clicks, alone.orders, alone.youngShare]).toEqual([0, 0, 0])
  })

  it('weigh with maturity decays first, then matures; without it, exactly as before', () => {
    const days: DayEvidence[] = [
      { daysAgo: 0, clicks: 10, orders: 0, salesCents: 0, costCents: 300, pullAge: 0, young: true },
      { daysAgo: 30, clicks: 100, orders: 2, salesCents: 16_000, costCents: 3000, pullAge: 7 },
      { daysAgo: 95, clicks: 999, orders: 9, salesCents: 99_999, costCents: 9999, pullAge: 7 },
    ]
    const plain = weigh(days)
    expect(weigh(days, { maturity: null })).toEqual(plain)
    expect(weigh(days, { maturity: undefined })).toEqual(plain)
    const matured = weigh(days, { maturity: M })
    expect(matured.clicks).toBeCloseTo(50 + 10 * 0.6)
    expect(matured.orders).toBeCloseTo(1)
    // Every copy settled and none young: the same numbers as without maturity.
    const settled = days.map(({ young: _y, ...d }) => ({ ...d, pullAge: 7 }))
    const a = weigh(settled, { maturity: M })
    for (const k of ['clicks', 'orders', 'salesCents', 'costCents'] as const) expect(a[k]).toBeCloseTo(plain[k], 9)
  })
})

/** One keyword's grouped rows (what load.ts sums in SQL). */
const group = (targetId: string, pullAge: number, young: boolean, e: Evidence, sales30 = 0): NowcastGroup => ({ targetId, pullAge, young, ...e, sales30 })

describe('nowcastEvidence', () => {
  it('matures each keyword under its own curve, and nowcasts its 30-day ad sales', () => {
    const product: LagShares = { orders: Array(LAG_AGES).fill(1), sales: Array(LAG_AGES).fill(1) }
    const out = nowcastEvidence([
      group('t1', 7, false, ev(300, 3, 24_000, 9000), 24_000), group('t1', 0, true, ev(20, 1, 8000, 600), 8000),
      group('t2', 7, false, ev(300, 3, 24_000, 9000), 24_000), group('t2', 0, true, ev(20, 1, 8000, 600), 8000),
    ], (id) => (id === 't2' ? product : SHARES))
    expect(out.evidence.get('t1')!.clicks).toBeCloseTo(312)
    expect(out.evidence.get('t2')!.clicks).toBeCloseTo(320)
    expect(out.adSales30.get('t1')).toBeCloseTo(24_000 + 8000 / 0.5)
    expect(out.adSales30.get('t2')).toBeCloseTo(32_000)
    expect(out.youngShare.get('t1')).toBeCloseTo(12 / 312)
    expect(out.totals.clicks).toBeCloseTo(632)
  })

  it('with every copy settled and no young day, gives the settled evidence — and the brain decides the same', () => {
    const settled = new Map([['t1', ev(40, 1, 8000, 1000)], ['t2', ev(300, 6, 48_000, 7500)], ['t3', ev(5, 0, 0, 100)]])
    const groups = [...settled].map(([id, e]) => group(id, 15, false, e))
    const out = nowcastEvidence(groups, () => priorShares())
    for (const [id, e] of settled) {
      const n = out.evidence.get(id)!
      for (const k of ['clicks', 'orders', 'salesCents', 'costCents'] as const) expect(n[k]).toBeCloseTo(e[k], 9)
    }
    const m = market(settled)
    const a = buildFacts(m, run()).map((f) => decide(f))
    const b = buildFacts({ ...m, evidence: out.evidence }, run()).map((f) => decide(f))
    expect(b.map((d) => [d.action, d.layer, d.bidCents, d.goalBidCents])).toEqual(a.map((d) => [d.action, d.layer, d.bidCents, d.goalBidCents]))
  })
})

function market(evidence: Map<string, Evidence>): MarketRows {
  return {
    market: 'IT', dataDay: '2026-10-01',
    campaigns: new Map([['c1', { id: 'c1', status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, minBidCents: null, maxBidCents: null, ownTargetAcos: undefined, allowlisted: true }]]),
    adGroups: new Map([['g1', { id: 'g1', campaignId: 'c1', status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families: ['famA'] }]]),
    targets: ['t1', 't2', 't3'].map((id, i) => ({ id, adGroupId: 'g1', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `word ${i}`, bidCents: 20 + i * 10, suppressedFromBidCents: null })),
    evidence,
    prices: new Map([['famA', 8000]]),
  }
}
const run = (): RunRows => ({
  marketBrakes: [], strategy: new Map([['g1', { target: { kind: 'ACOS', pct: 20 }, acosPct: 20, band: null, goal: 'PROFIT', minBidCents: null, maxBidCents: 80, maxChangePct: 25 }]]),
  accountDefaultPct: null, personHeld: new Set(), holds: [], enrollments: new Map(), lastSteps: new Map(),
})

describe('the shadow comparison', () => {
  const facts = (extra: Partial<TargetFacts> = {}): TargetFacts => ({
    targetId: 'k1', currentCents: 20, dataDay: '2026-10-01',
    chain: [{ level: 'target', evidence: ev(200, 2, 16_000, 4000) }, { level: 'market', evidence: ev(10_000, 100, 800_000, 200_000) }],
    goal: { target: { kind: 'ACOS', pct: 20 } }, limits: { maxChangePct: 25 }, ...extra,
  })
  const pair = (f: TargetFacts) => ({ facts: f, decision: decide(f) })

  it('says nothing when both decide the same, and names the nowcast decision when they differ', () => {
    const settled = pair(facts())
    expect(nowcastNote(settled, pair(facts()), 0.1)).toBeNull()
    const nowcast = pair(facts({ dataDay: '2026-10-07', chain: [{ level: 'target', evidence: ev(230, 5, 40_000, 4600) }, { level: 'market', evidence: ev(10_000, 110, 880_000, 200_000) }] }))
    expect(nowcast.decision.bidCents).not.toBe(settled.decision.bidCents)
    const note = nowcastNote(settled, nowcast, 0.12)!
    expect(note).toMatch(/^nowcast to 2026-10-07: would (write|hold at) \d+¢ \((goal|band|limit); CR \d+(\.\d+)?% vs \d+(\.\d+)?% settled; young days 12% of its clicks\)$/)
  })

  it('counts what differs, higher and lower, and words the run line', () => {
    const s1 = pair(facts())
    const s2 = pair(facts({ targetId: 'k2' }))
    const n1 = pair(facts({ dataDay: '2026-10-07', chain: [{ level: 'target', evidence: ev(230, 5, 40_000, 4600) }, { level: 'market', evidence: ev(10_000, 110, 880_000, 200_000) }] }))
    const n2 = pair(facts({ targetId: 'k2', dataDay: '2026-10-07' }))
    const { notes, summary } = compareNowcast([s1, s2], [n1, n2], new Map([['k1', 0.12]]), { dataDay: '2026-10-07', curve: 'IT market curve (vintages, 20 days, L(0) 60 %)', youngPct: 9.5 })
    expect([...notes.keys()]).toEqual(['k1'])
    expect(summary).toMatchObject({ compared: 2, differ: 1, higher: n1.decision.bidCents > s1.decision.bidCents ? 1 : 0 })
    expect(summary.higher + summary.lower).toBe(1)
    expect(nowcastSummaryWords(summary)).toBe(`nowcast to 2026-10-07 (IT market curve (vintages, 20 days, L(0) 60 %)): 1 of 2 differ (${summary.higher} higher, ${summary.lower} lower), young days 9.5%`)
    expect(nowcastSummaryWords(null)).toBe('')
  })

  it('on: names the young days in the why of a decision resting on them, never an override\'s', () => {
    const notes = nowcastOnNotes([{ targetId: 'a', layer: 'goal' }, { targetId: 'b', layer: 'pin' }, { targetId: 'c', layer: 'band' }], new Map([['a', 0.163], ['b', 0.2], ['c', 0]]), '2026-10-07')
    expect([...notes]).toEqual([['a', 'nowcast to 2026-10-07: young days 16% of its clicks']])
    expect(youngPctOf({ clicks: 200, youngClicks: 29, youngCapped: 0, tooYoung: 0 })).toBe(14.5)
    expect(youngPctOf({ clicks: 0, youngClicks: 0, youngCapped: 0, tooYoung: 0 })).toBe(0)
  })

  it('a keyword the settled run already stepped today takes no second step in the nowcast (its step re-keyed to the nowcast day)', () => {
    // Stepped today on the settled data day: 50¢ → 40¢; the goal still wants far lower (a 16¢ goal bid).
    const step = { dataDay: '2026-10-01', fromCents: 50, toCents: 40 }
    const settled = pair(facts({ currentCents: 40, lastStep: step }))
    const nowcastFacts = (lastStep: typeof step) => facts({ currentCents: 40, dataDay: '2026-10-07', lastStep })
    // Read raw, the nowcast's newer data day sees no step "today" and steps again from 40¢: a false difference.
    const raw = pair(nowcastFacts(step))
    expect(raw.decision.bidCents).toBeLessThan(settled.decision.bidCents)
    expect(nowcastNote(settled, raw, 0)).not.toBeNull()
    // Re-keyed, the same step anchors the nowcast too: the same decision, no note, nothing counted.
    const steps = nowcastLastSteps(new Map([['k1', step]]), '2026-10-01', '2026-10-07')
    const rekeyed = pair(nowcastFacts(steps.get('k1')!))
    expect(rekeyed.decision).toMatchObject({ action: settled.decision.action, bidCents: settled.decision.bidCents })
    expect(nowcastNote(settled, rekeyed, 0)).toBeNull()
    expect(compareNowcast([settled], [rekeyed], new Map(), { dataDay: '2026-10-07', curve: 'c', youngPct: 0 }).summary.differ).toBe(0)
  })

  it('re-keys only the steps of the settled day or newer; an older step keeps its day (a new day, a new step)', () => {
    const steps = new Map([
      ['old', { dataDay: '2026-09-30', fromCents: 30, toCents: 25 }],
      ['today', { dataDay: '2026-10-01', fromCents: 30, toCents: 25 }],
      ['ahead', { dataDay: '2026-10-07', fromCents: 30, toCents: 25 }],
    ])
    const out = nowcastLastSteps(steps, '2026-10-01', '2026-10-07')
    expect([...out].map(([id, s]) => [id, s.dataDay])).toEqual([['old', '2026-09-30'], ['today', '2026-10-07'], ['ahead', '2026-10-07']])
    expect(steps.get('today')!.dataDay).toBe('2026-10-01') // the run's own map is not changed
    // Switched on (rows read with the nowcast carry the settled day): the run's anchors re-keyed; settled rows: the same run.
    const run = { lastSteps: steps, other: 1 }
    expect(runForRows({ dataDay: '2026-10-01' }, run)).toBe(run)
    expect(runForRows({ dataDay: '2026-10-07', nowcast: { settledDay: '2026-10-01' } }, run).lastSteps.get('today')!.dataDay).toBe('2026-10-07')
  })

  it('a brake on both sides is no difference', () => {
    const b: Decision = decide(facts({ brakes: ['campaign paused'] }))
    expect(nowcastNote({ facts: facts(), decision: b }, { facts: facts({ dataDay: '2026-10-07' }), decision: b }, 0)).toBeNull()
  })
})

describe('the identity at rest', () => {
  it('maturity 1 for every copy and no young day is the plain sum', () => {
    const items = [{ ...ev(10, 1, 900, 50), pullAge: 0 }, { ...ev(5, 0, 0, 20), pullAge: 3 }, { ...ev(7, 1, 800, 30) }]
    const m = matureSum(items, ONES)
    expect([m.clicks, m.orders, m.salesCents, m.costCents]).toEqual([22, 2, 1700, 100])
  })
})
