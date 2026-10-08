/**
 * BID BRAIN BB-22 — the learned hour factors in a run (hour-factors-apply.ts) and the store's pure helpers
 * (hour-factors-store.ts), on made-up values (public repository).
 *
 *   identical  off and shadow give the bid brain exactly the facts and decisions it has without BB-22 (byte for byte);
 *              shadow only adds words for the why
 *   on         where the product's brain owns the hours lever: the cell's lanes move inside their limits, the plan's
 *              note names it, the keyword bids stay exactly the same (only the placements move); where it does not own
 *              it: identical, and the words say why
 *   locked     an Owner-locked hour and a Min-bid hour never change, under on too
 *   spec       a blend keeps all three lanes, a single-placement target its one lane
 *   store      the schedule's basis ignores key order; the plan in force each day; when a product is learned again;
 *              lane totals as top-of-search evidence; off and a shadow light tick read nothing
 */
import { describe, expect, it } from 'vitest'
import { decide } from './decide.js'
import { buildFacts, type AdGroupRow, type CampaignRow, type MarketRows, type RunRows, type TargetRow } from './facts.js'
import type { Evidence } from './estimator.js'
import type { PlanHour } from './plan-hour.js'
import { approvedLanes, learnedSpec, moveOf, runHourFactors, type CampaignHourInput } from './hour-factors-apply.js'
import { hourFactorsForRun, laneEvidence, learnDue, LEARN_EVERY_HOURS, scheduleBasis, weeksByDay, type StoredHourFactors } from './hour-factors-store.js'
import type { RankTargetSpec } from '../rank-controller.js'

const spec = (extra: Partial<RankTargetSpec> = {}): RankTargetSpec => ({
  key: 'top', placement: 'PLACEMENT_TOP', targetISPct: null, acosCapPct: null, maxCpcCents: 500, biasPct: 200, pause: false, allOut: false, ...extra,
})
const hourOf = (s: RankTargetSpec | null, extra: Partial<PlanHour> = {}): PlanHour => ({ scheduleId: 's1', name: 'IT TEST PLAN', key: s?.key ?? null, spec: s, event: null, dayMaxCpcCents: 500, ...extra })

const campaign = (id: string): CampaignRow => ({
  id, status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null,
  minBidCents: null, maxBidCents: null, ownTargetAcos: undefined, allowlisted: true, biddingStrategy: 'LEGACY_FOR_SALES', placements: [],
})
const group = (id: string, campaignId: string): AdGroupRow => ({ id, campaignId, status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families: ['fam'], productIds: ['fam'] })

/** One owned campaign (c1, with a plan hour) and one not owned (c2), four keywords each; a 20 % ACoS goal. */
function market(): { m: MarketRows; run: RunRows } {
  const targets: TargetRow[] = []
  const evidence = new Map<string, Evidence>()
  for (const [g, bids] of [['g1', [10, 20, 30, 40]], ['g2', [15, 25, 35, 45]]] as const) {
    bids.forEach((bid, i) => {
      const id = `${g}-t${i}`
      targets.push({ id, adGroupId: g, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `jacket ${i}`, bidCents: bid, suppressedFromBidCents: null })
      evidence.set(id, { clicks: 200 + 50 * i, orders: 2 + i, salesCents: (2 + i) * 8000, costCents: (200 + 50 * i) * 30 })
    })
  }
  const m: MarketRows = {
    market: 'IT', dataDay: '2026-10-01', campaigns: new Map([['c1', campaign('c1')], ['c2', campaign('c2')]]),
    adGroups: new Map([['g1', group('g1', 'c1')], ['g2', group('g2', 'c2')]]), targets, evidence, prices: new Map([['fam', 8000]]),
  }
  const run: RunRows = {
    marketBrakes: [], accountDefaultPct: null, personHeld: new Set(), holds: [], enrollments: new Map(), lastSteps: new Map(),
    strategy: new Map([['g1', { target: { kind: 'ACOS', pct: 20 }, acosPct: 20, band: { loPct: 18, hiPct: 28 }, goal: 'PROFIT', minBidCents: null, maxBidCents: 90, maxChangePct: 25 }], ['g2', { target: { kind: 'ACOS', pct: 20 }, acosPct: 20, band: null, goal: 'PROFIT', minBidCents: null, maxBidCents: 90, maxChangePct: 25 }]]),
    planHours: new Map([['c1', hourOf(spec({ lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 200 }, { placement: 'PLACEMENT_PRODUCT_PAGE', biasPct: 50 }] }))]]),
    minBidEntries: new Map(), owned: new Set(['c1']),
  }
  return { m, run }
}

const input = (extra: Partial<CampaignHourInput> = {}): CampaignHourInput => ({
  campaignId: 'c1', hour: market().run.planHours!.get('c1')!, d: 2, h: 14, rho: 0.75, rhoLo: 0.6, rhoHi: 0.9, learned: 0.9, painted: 1.2,
  stale: null, locked: false, movePct: 30, tosCapPct: null, tosRatio: null, applies: true, whyNot: null, ...extra,
})
const decisionsOf = (m: MarketRows, run: RunRows) => {
  const facts = buildFacts(m, run)
  return { facts, decisions: facts.map((f) => decide(f)) }
}

describe('BB-22 — the run under the flag', () => {
  it('off and shadow: the facts and decisions are byte for byte those without BB-22; shadow only adds words', () => {
    const { m, run } = market()
    const before = JSON.stringify(decisionsOf(m, run))
    for (const mode of ['off', 'shadow'] as const) {
      const out = runHourFactors(run.planHours!, [input()], mode, { wantNotes: true })
      expect(out.planHours.get('c1')).toBe(run.planHours!.get('c1'))
      expect(JSON.stringify(decisionsOf(m, { ...run, planHours: out.planHours }))).toBe(before)
      if (mode === 'off') expect(out.notes.size).toBe(0)
      else expect(out.notes.get('c1')).toMatch(/^hour factors \(shadow — nothing changed\): Tue 14:00: learned ×0\.90 against the plan's ×1\.20 → asks ×0\.75 of the cell; 90 %: ×0\.60–×0\.90 — ×0\.75: top-of-search 200 → 125 % \(limits 110–200 %\), product-page 50 → 13 % \(limits 5–50 %\)$/)
    }
  })

  it('on, the product\'s brain owning the hours lever: the lanes move inside the limits, the keyword bids stay exactly the same', () => {
    const { m, run } = market()
    const before = decisionsOf(m, run)
    const out = runHourFactors(run.planHours!, [input()], 'on', { wantNotes: true })
    const moved = out.planHours.get('c1')!
    expect(moved).not.toBe(run.planHours!.get('c1'))
    expect(moved.spec!.lanes!.map((l) => [l.placement, l.biasPct])).toEqual([['PLACEMENT_TOP', 125], ['PLACEMENT_REST_OF_SEARCH', 0], ['PLACEMENT_PRODUCT_PAGE', 13]])
    expect(moved.learned).toMatch(/^learned hour factor: Tue 14:00/)
    expect(out.notes.size).toBe(0)
    const after = decisionsOf(m, { ...run, planHours: out.planHours })
    // The keyword bids: identical, every one (the move lands on the placement lanes only).
    expect(after.decisions.map((d) => [d.targetId, d.action, d.layer, d.bidCents, d.goalBidCents])).toEqual(before.decisions.map((d) => [d.targetId, d.action, d.layer, d.bidCents, d.goalBidCents]))
    // The owned campaign's lanes are the learned ones; the other campaign's facts are untouched.
    const c1 = after.facts.find((f) => f.targetId === 'g1-t0')!
    expect(c1.lanes!.map((l) => [l.lane, l.planPct])).toEqual([['TOP_OF_SEARCH', 125], ['REST_OF_SEARCH', 0], ['PRODUCT_PAGE', 13]])
    expect(c1.planNote).toMatch(/hourly plan IT TEST PLAN: top — learned hour factor: Tue 14:00/)
    // BB-18's stack ceiling still reads the approved cell (300 % top of search → ×3): the keyword bids cannot move through it.
    expect(c1.ratioCeiling).toBe(3)
    expect(c1.ratioCeiling).toBe(before.facts.find((f) => f.targetId === 'g1-t0')!.ratioCeiling)
    expect(JSON.stringify(after.facts.filter((f) => f.targetId.startsWith('g2')))).toBe(JSON.stringify(before.facts.filter((f) => f.targetId.startsWith('g2'))))
    // And never above the approved cell: every lane at or below the plan's.
    for (const l of c1.lanes!) expect(l.planPct).toBeLessThanOrEqual(before.facts.find((f) => f.targetId === 'g1-t0')!.lanes!.find((x) => x.lane === l.lane)!.planPct)
  })

  it('on where the product\'s brain does not own the hours lever: identical, and the words say why', () => {
    const { m, run } = market()
    const before = JSON.stringify(decisionsOf(m, run))
    const out = runHourFactors(run.planHours!, [input({ applies: false, whyNot: 'the product\'s hours lever is OBSERVE' })], 'on', { wantNotes: true })
    expect(JSON.stringify(decisionsOf(m, { ...run, planHours: out.planHours }))).toBe(before)
    expect(out.notes.get('c1')).toMatch(/^hour factors \(not applied: the product's hours lever is OBSERVE\): Tue 14:00/)
    // A light tick writes no words.
    expect(runHourFactors(run.planHours!, [input({ applies: false, whyNot: 'x' })], 'on', { wantNotes: false }).notes.size).toBe(0)
  })

  it('an Owner-locked hour and a Min-bid hour never change, under on too', () => {
    const { run } = market()
    const locked = runHourFactors(run.planHours!, [input({ locked: true })], 'on', { wantNotes: true })
    expect(locked.planHours.get('c1')).toBe(run.planHours!.get('c1'))
    expect(locked.notes.get('c1')).toMatch(/^hour factors: Tue 14:00: an hour the Owner locked \(d2h14\) — never changed$/)
    const floorHour = hourOf(spec({ key: 'min', pause: true, biasPct: null, floorBidCents: 3 }))
    const minBid = runHourFactors(new Map([['c1', floorHour]]), [input({ hour: floorHour })], 'on', { wantNotes: true })
    expect(minBid.planHours.get('c1')).toBe(floorHour)
    expect(minBid.moves.get('c1')!.status).toBe('min_bid')
  })
})

describe('BB-22 — the cell\'s spec', () => {
  it('a blend owns all three lanes; a single-placement target its one lane', () => {
    expect(approvedLanes(spec({ lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 150 }] }))).toEqual([
      { lane: 'TOP_OF_SEARCH', pct: 150 }, { lane: 'REST_OF_SEARCH', pct: 0 }, { lane: 'PRODUCT_PAGE', pct: 0 },
    ])
    expect(approvedLanes(spec({ placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 40 }))).toEqual([{ lane: 'REST_OF_SEARCH', pct: 40 }])
    const single = spec({ placement: 'PLACEMENT_TOP', biasPct: 100 })
    const move = moveOf(input({ hour: hourOf(single) }))
    expect(learnedSpec(single, move)).toEqual({ ...single, biasPct: 50 })
    const kept = moveOf(input({ hour: hourOf(single), rho: 0.97 }))
    expect(learnedSpec(single, kept)).toBe(single)
  })
})

describe('BB-22 — the store\'s pure helpers', () => {
  it('the schedule\'s basis ignores the order of keys and changes with the week', () => {
    const a = scheduleBasis({ windows: [{ startHour: 0, endHour: 6, targetKey: 'min' }], defaultTargetKey: 'top', timezone: 'Europe/Rome', targetOverrides: { top: { biasPct: 120, maxCpcCents: 90 } } })
    const b = scheduleBasis({ targetOverrides: { top: { maxCpcCents: 90, biasPct: 120 } }, timezone: 'Europe/Rome', defaultTargetKey: 'top', windows: [{ targetKey: 'min', endHour: 6, startHour: 0 }] })
    expect(a).toBe(b)
    expect(scheduleBasis({ windows: [{ startHour: 0, endHour: 7, targetKey: 'min' }], defaultTargetKey: 'top', timezone: 'Europe/Rome', targetOverrides: { top: { biasPct: 120, maxCpcCents: 90 } } })).not.toBe(a)
  })

  it('the plan in force each day: the newest version before the day\'s noon, else the schedule\'s own week', () => {
    const own = { windows: ['own'], defaultTargetKey: 'own' }
    const v1 = { windows: ['v1'], defaultTargetKey: 'v1', createdAt: new Date('2026-09-10T08:00:00Z') }
    const v2 = { windows: ['v2'], defaultTargetKey: 'v2', createdAt: new Date('2026-09-12T15:00:00Z') }
    const w = weeksByDay(['2026-09-09', '2026-09-10', '2026-09-12', '2026-09-13'], own, [v2, v1])
    expect([...w.values()].map((x) => x.defaultTargetKey)).toEqual(['own', 'v1', 'v1', 'v2'])
    expect([...weeksByDay(['2026-09-09'], own, []).values()][0]).toEqual({ windows: ['own'], defaultTargetKey: 'own' })
  })

  it('a product is learned again when never learned, after a day, when a plan changed or a campaign is not covered', () => {
    const now = new Date('2026-10-08T10:00:00Z')
    const stored = (hoursAgo: number): StoredHourFactors => ({
      productId: 'p', market: 'IT', campaignIds: ['c1'], learnedAt: new Date(now.getTime() - hoursAgo * 3_600_000),
      factors: { plans: [{ campaignId: 'c1', scheduleId: 's1', basis: 'b1' }] } as never,
    })
    expect(learnDue(null, [], now)).toBe('never learned')
    expect(learnDue(stored(2), [{ campaignId: 'c1', basis: 'b1' }], now)).toBeNull()
    expect(learnDue(stored(LEARN_EVERY_HOURS), [{ campaignId: 'c1', basis: 'b1' }], now)).toMatch(/hours ago/)
    expect(learnDue(stored(2), [{ campaignId: 'c1', basis: 'b2' }], now)).toMatch(/changed since/)
    expect(learnDue(stored(2), [{ campaignId: 'c9', basis: 'b1' }], now)).toMatch(/not covered/)
  })

  it('lane totals as top-of-search evidence', () => {
    expect(laneEvidence([{ lane: 'TOP_OF_SEARCH', clicks: 100, orders: 3 }, { lane: 'REST_OF_SEARCH', clicks: 300, orders: 6 }, { lane: 'PRODUCT_PAGE', clicks: 100, orders: 1 }]))
      .toEqual({ tosClicks: 100, tosOrders: 3, clicks: 500, orders: 10 })
    expect(laneEvidence([])).toBeNull()
  })

  it('off, no plan hour, and a shadow light tick: the run as given, nothing read', async () => {
    const { run } = market()
    const now = new Date('2026-10-08T10:00:00Z')
    for (const ctx of [{ mode: 'off' as const, light: false }, { mode: 'shadow' as const, light: true }]) {
      const out = await hourFactorsForRun('IT', run, { now, clockNow: now, ...ctx })
      expect(out.run).toBe(run)
      expect(out.notes.size).toBe(0)
    }
    const none = { ...run, planHours: new Map() }
    expect((await hourFactorsForRun('IT', none, { now, clockNow: now, mode: 'on', light: false })).run).toBe(none)
  })
})
