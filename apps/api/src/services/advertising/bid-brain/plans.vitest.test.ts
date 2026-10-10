/**
 * BID BRAIN BB-7 + BB-18 — the hourly plan as the brain's input, and the bid stack (pure parts).
 *
 *   plan hour   a blended target sets three lanes (an undeclared one at 0), a single one its lane; a Min-bid target the
 *               keyword floor; the anti-flap keeps a third entry serving; a base-bid hour is not carried out
 *   bid stack   Amazon's dynamic bidding in each lane's ceiling (×2 top of search, ×1.5 elsewhere for "up and down"); the
 *               paid CPC ÷ bid may pass 1 when placements lift the price (IT_BMM_Gale: 28¢ on 26¢, 36¢ on 22¢)
 *   C2          the IT_Auto_Close case: a plan asks 150 % at the top of search under a 45¢ ceiling — the base bid is held
 *               at the ceiling and the placement at what the ceiling allows; never a bid no one may set
 *   serving     r̂ is taken against the bid that served the window, so a later move of today's bid does not move it
 *   writer      the placements a campaign gets, and nothing when nothing changes
 */
import { describe, expect, it } from 'vitest'
import { laneHeadroom, type RankTargetSpec } from '../rank-controller.js'
import { hourWindow, hourWords, planFacts, type PlanHour } from './plan-hour.js'
import { bidForAcos, limitRange, placementsFor, stackCeiling, type Lane } from './recipe.js'
import { cpcRatio, laneCpcRatio } from './estimator.js'
import { decide, type TargetFacts } from './decide.js'
import { placementPlan } from './live-writer.js'
import { placementWrites } from './shadow.js'
import type { Decision } from './decide.js'
import { isFullSlot } from '../../../jobs/ads-bid-brain.job.js'

const spec = (over: Partial<RankTargetSpec> = {}): RankTargetSpec => ({
  key: 'all-out', placement: 'PLACEMENT_TOP', targetISPct: null, acosCapPct: null, maxCpcCents: 55, biasPct: 150, pause: false, allOut: false, ...over,
})
const hour = (s: RankTargetSpec | null, over: Partial<PlanHour> = {}): PlanHour => ({ scheduleId: 's1', name: 'IT GALE JACKET', key: s?.key ?? null, spec: s, event: null, ...over })
const flap = { entriesToday: 0, inMinBid: false, maxEntries: 2 }

describe('BB-7 — the plan hour as the brain\'s input', () => {
  it('a blended target sets all three lanes (an undeclared one at 0), each with the ceiling and Amazon\'s dynamic bidding', () => {
    const blended = spec({ lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 150 }, { placement: 'PLACEMENT_PRODUCT_PAGE', biasPct: 50 }] })
    const f = planFacts(hour(blended), { biddingStrategy: 'AUTO_FOR_SALES' }, flap)!
    expect(f.lanes).toEqual([
      { lane: 'TOP_OF_SEARCH', planPct: 150, maxCpcCents: 55, baseCeilingCents: 55, dynamic: 2 },
      { lane: 'REST_OF_SEARCH', planPct: 0, maxCpcCents: 55, baseCeilingCents: 55, dynamic: 1.5 },
      { lane: 'PRODUCT_PAGE', planPct: 50, maxCpcCents: 55, baseCeilingCents: 55, dynamic: 1.5 },
    ])
    expect(f.minBidHour).toBeNull()
    expect(f.note).toBe('hourly plan IT GALE JACKET: all-out')
  })

  it('a single-placement target sets its lane only; a legacy campaign has no dynamic uplift', () => {
    const f = planFacts(hour(spec({ placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 40 })), { biddingStrategy: 'LEGACY_FOR_SALES' }, flap)!
    expect(f.lanes).toEqual([{ lane: 'REST_OF_SEARCH', planPct: 40, maxCpcCents: 55, baseCeilingCents: 55, dynamic: 1 }])
  })

  it('Owner decision A (10-10) — the keyword bid holds THIS hour\'s ceiling (it was the day\'s lowest); the hour\'s window names it', () => {
    const f = planFacts(hour(spec({ maxCpcCents: 60 }), { window: { fromHour: 14, toHour: 16 } }), { biddingStrategy: 'LEGACY_FOR_SALES' }, flap)!
    expect(f.lanes[0]).toMatchObject({ maxCpcCents: 60, baseCeilingCents: 60 })
    expect(limitRange({}, f.lanes)).toMatchObject({ upper: 60, upperFrom: 'the top-of-search CPC ceiling' })
    expect(placementsFor(40, f.lanes, { aim: 0.2, hi: 0.28 })[0]).toMatchObject({ pct: 50, held: 'the top-of-search CPC ceiling 60¢' })
    // The run of hours with the same target around the hour (the plan's time zone), and its words.
    const keys = [...Array(8).fill('min'), ...Array(6).fill('rest'), 'own', 'own', ...Array(8).fill('rest')]
    expect(hourWindow(keys, 14)).toEqual({ fromHour: 14, toHour: 16 })
    expect(hourWindow(keys, 9)).toEqual({ fromHour: 8, toHour: 14 })
    expect(hourWindow(keys, 23)).toEqual({ fromHour: 16, toHour: 24 })
    expect(hourWords({ fromHour: 14, toHour: 16 })).toBe('the plan at 14:00–16:00')
    expect(hourWords(null)).toBe('the plan this hour')
  })

  it('a Min-bid hour floors every keyword (its own floor, else 2¢); base bid "suppress" is a Min-bid hour too', () => {
    expect(planFacts(hour(spec({ key: 'min', pause: true, floorBidCents: 3 })), { biddingStrategy: null }, flap)).toMatchObject({ minBidHour: { floorCents: 3 } })
    expect(planFacts(hour(spec({ key: 'min', pause: true })), { biddingStrategy: null }, flap)?.minBidHour).toEqual({ floorCents: 2 })
    expect(planFacts(hour(spec({ key: 'sup', bidMode: 'suppress' })), { biddingStrategy: null }, flap)?.minBidHour).toEqual({ floorCents: 2 })
  })

  it('live fix 10-08 — a Min-bid hour sets every placement lane to 0 % (AB-2: the strategy\'s switch is the stop recipe\'s, with its own why)', () => {
    const f = planFacts(hour(spec({ key: 'min', pause: true, floorBidCents: 3 })), { biddingStrategy: 'AUTO_FOR_SALES' }, flap)!
    expect(f.lanes).toEqual([
      { lane: 'TOP_OF_SEARCH', planPct: 0, maxCpcCents: null, baseCeilingCents: null, dynamic: 2 },
      { lane: 'REST_OF_SEARCH', planPct: 0, maxCpcCents: null, baseCeilingCents: null, dynamic: 1.5 },
      { lane: 'PRODUCT_PAGE', planPct: 0, maxCpcCents: null, baseCeilingCents: null, dynamic: 1.5 },
    ])
    expect(f.note).toBe('hourly plan IT GALE JACKET: min — every placement at 0 %')
    const legacy = planFacts(hour(spec({ key: 'min', pause: true })), { biddingStrategy: 'LEGACY_FOR_SALES' }, flap)!
    expect(legacy.lanes.map((l) => l.planPct)).toEqual([0, 0, 0])
    expect(legacy.note).toBe('hourly plan IT GALE JACKET: min — every placement at 0 %')
    // The anti-flap's "kept serving" hour zeroes nothing.
    expect(planFacts(hour(spec({ key: 'min', pause: true })), { biddingStrategy: null }, { entriesToday: 2, inMinBid: false, maxEntries: 2 })!.lanes).toEqual([])
  })

  it('the anti-flap: a third Min-bid entry in a UTC day keeps the campaign serving; an hour already in Min bid stays floored', () => {
    const min = hour(spec({ key: 'min', pause: true }))
    const kept = planFacts(min, { biddingStrategy: null }, { entriesToday: 2, inMinBid: false, maxEntries: 2 })!
    expect(kept.minBidHour).toBeNull()
    expect(kept.note).toMatch(/kept serving: it entered Min bid 2 times today \(UTC\), at most 2 a day/)
    expect(planFacts(min, { biddingStrategy: null }, { entriesToday: 2, inMinBid: true, maxEntries: 2 })?.minBidHour).toEqual({ floorCents: 2 })
  })

  it('a base-bid hour is not carried out, and the why says so; no target, no facts', () => {
    expect(planFacts(hour(spec({ bidMode: 'absolute', bidValueCents: 30 })), { biddingStrategy: null }, flap)).toMatchObject({ baseBidIgnored: true, note: expect.stringMatching(/its base bid is not applied/) })
    expect(planFacts(hour(null), { biddingStrategy: null }, flap)).toBeNull()
  })
})

describe('BB-18 — the bid stack', () => {
  it('Amazon\'s dynamic bidding per lane: up and down ×2 at the top of search, ×1.5 elsewhere; down only ×1', () => {
    expect(laneHeadroom('AUTO_FOR_SALES', 'PLACEMENT_TOP')).toBe(2)
    expect(laneHeadroom('AUTO_FOR_SALES', 'PLACEMENT_PRODUCT_PAGE')).toBe(1.5)
    expect(laneHeadroom('LEGACY_FOR_SALES', 'PLACEMENT_TOP')).toBe(1)
    expect(stackCeiling([])).toBe(1)
    expect(stackCeiling([{ planPct: 150, dynamic: 1 }])).toBe(2.5)
    expect(stackCeiling([{ planPct: 0, dynamic: 2 }, { planPct: 50, dynamic: 1.5 }])).toBe(2.25)
  })

  it('IT_BMM_Gale: paid 28¢ on a 26¢ bid and 36¢ on 22¢ — read as they are when placements lift the price, not cut to 1', () => {
    const plus = { clicks: 20, costCents: 20 * 28 }
    const giubbotto = { clicks: 20, costCents: 20 * 36 }
    expect(cpcRatio(plus, 26)).toBe(1)
    expect(laneCpcRatio(plus, 26, null, 2.5)).toBeCloseTo(28 / 26, 6)
    expect(laneCpcRatio(giubbotto, 22, null, 2.5)).toBeCloseTo(36 / 22, 6)
    // With a ceiling of 1 it is the old ratio exactly.
    expect(laneCpcRatio(plus, 26, null, 1)).toBe(cpcRatio(plus, 26))
    // The goal bid follows: at 36¢ paid on 22¢ the same goal buys a 39 % lower bid than the clamp assumed.
    const at1 = bidForAcos(0.2, 0.0087, 8115, 1)
    const real = bidForAcos(0.2, 0.0087, 8115, laneCpcRatio(giubbotto, 22, null, 2.5))
    expect(Math.round((1 - real / at1) * 100)).toBe(39)
  })

  it('the lane ceiling holds the base bid × dynamic bidding at 0 %, and base × (1 + p) × dynamic with its placement', () => {
    const lanes: Lane[] = [{ lane: 'TOP_OF_SEARCH', planPct: 300, maxCpcCents: 55, dynamic: 2 }]
    expect(limitRange({}, lanes)).toMatchObject({ upper: 27, upperFrom: 'the top-of-search CPC ceiling (÷2 Amazon dynamic bidding)' })
    expect(placementsFor(20, lanes, { aim: 0.2, hi: 0.28 })).toEqual([
      { lane: 'TOP_OF_SEARCH', planPct: 300, pct: 37, held: 'the top-of-search CPC ceiling 55¢ with Amazon\'s dynamic bidding ×2' },
    ])
  })
})

const facts = (over: Partial<TargetFacts> = {}): TargetFacts => ({
  targetId: 't1', currentCents: 50,
  chain: [{ level: 'target', evidence: { clicks: 400, orders: 12, salesCents: 12 * 8000, costCents: 400 * 40 } }, { level: 'market', evidence: { clicks: 4000, orders: 120, salesCents: 120 * 8000, costCents: 4000 * 40 } }],
  goal: { target: { kind: 'ACOS', pct: 35 }, band: { loPct: 30, hiPct: 40 }, phase: null },
  limits: { maxChangePct: 25 }, dataDay: '2026-10-01', ...over,
})

describe('C2 and the serving bid', () => {
  it('IT_Auto_Close at a 45¢ ceiling: the base bid is held at the ceiling and the 150 % top of search at what it allows', () => {
    const lanes: Lane[] = [{ lane: 'TOP_OF_SEARCH', planPct: 150, maxCpcCents: 45, dynamic: 1 }]
    const over = decide(facts({ currentCents: 50, lanes }))
    // Owner decision A (10-10) — the goal's own move, held to this hour's ceiling (not the brain's limits); its 62¢ remembered.
    expect(over).toMatchObject({ action: 'write', layer: 'goal', bidCents: 45, beforeHour: 62 })
    expect(over.why).toMatch(/62¢ held to 45¢ by the hourly plan's ceiling this hour$/)
    expect(over.placements).toEqual([{ lane: 'TOP_OF_SEARCH', planPct: 150, pct: 0, held: 'the top-of-search CPC ceiling 45¢' }])
    const under = decide(facts({ currentCents: 30, lanes }))
    expect(under.bidCents).toBeLessThanOrEqual(45)
    const top = under.placements[0]
    expect(under.bidCents * (1 + top.pct / 100)).toBeLessThanOrEqual(45)
  })

  it('r̂ against the bid that served: today\'s bid moving alone does not move the goal', () => {
    const served = { servingCents: 40, ratioCeiling: 1 }
    const a = decide(facts({ currentCents: 40, ...served }))
    const b = decide(facts({ currentCents: 30, ...served }))
    expect(a.goalBidCents).not.toBeNull()
    // The same CPC ÷ bid in both whys, so the same goal before the step.
    const ratio = (why: string) => /CPC\/bid ([\d.]+)/.exec(why)?.[1]
    expect(ratio(a.why)).toBe(ratio(b.why))
    // Without it the ratio followed today's bid (40¢ paid ÷ 30¢ now, clamped to 1 against 1.00 at 40¢ — a different goal).
    const c = decide(facts({ currentCents: 30 }))
    expect(ratio(c.why)).toBe('1.00')
    expect(ratio(decide(facts({ currentCents: 60 })).why)).toBe('0.67')
  })
})

describe('the placement write of one campaign', () => {
  const lanes: Lane[] = [
    { lane: 'TOP_OF_SEARCH', planPct: 150, maxCpcCents: 55, dynamic: 1 },
    { lane: 'REST_OF_SEARCH', planPct: 0, maxCpcCents: 55, dynamic: 1 },
    { lane: 'PRODUCT_PAGE', planPct: 50, maxCpcCents: 55, dynamic: 1 },
  ]
  it('a blended hour: every lane as planned and capped; a lane it does not name goes to 0', () => {
    const p = placementPlan({ lanes, current: [{ placement: 'PLACEMENT_TOP', percentage: 100 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 20 }], maxBidCents: 30 })!
    expect(p.adjustments).toEqual([
      { placement: 'PLACEMENT_TOP', percentage: 83 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
      { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 50 },
    ])
    expect(p.changes).toEqual([
      { lane: 'top-of-search', from: 100, to: 83, held: 'the top-of-search CPC ceiling 55¢' },
      { lane: 'rest-of-search', from: 20, to: 0, held: null },
      { lane: 'product-page', from: 0, to: 50, held: null },
    ])
  })

  it('nothing when the campaign already holds the hour; a single lane keeps the others as they are', () => {
    expect(placementPlan({ lanes, current: [{ placement: 'PLACEMENT_TOP', percentage: 83 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 50 }], maxBidCents: 30 })).toBeNull()
    const one = placementPlan({ lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 60, maxCpcCents: null, dynamic: 1 }], current: [{ placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 25 }], maxBidCents: 30 })!
    expect(one.adjustments).toEqual([{ placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 25 }, { placement: 'PLACEMENT_TOP', percentage: 60 }])
  })
})

describe('the cadence', () => {
  it('the full run is the :45 tick of every 6th UTC hour; every other tick is for the campaigns the brain owns', () => {
    expect(isFullSlot(new Date('2026-10-08T06:45:00Z'))).toBe(true)
    expect(isFullSlot(new Date('2026-10-08T18:45:00Z'))).toBe(true)
    expect(isFullSlot(new Date('2026-10-08T06:30:00Z'))).toBe(false)
    expect(isFullSlot(new Date('2026-10-08T07:45:00Z'))).toBe(false)
  })
})

describe('review 3 — two Min-bid windows on one data day', () => {
  const base = (over: Partial<TargetFacts> = {}) => facts({ currentCents: 3, overrides: {}, ...over })
  it('each exit gives the bid back where the day\'s step left it, never a fresh step from it', () => {
    // Day D: the goal stepped 40 → 50 (25 %), then a Min-bid hour floored it; the bid before the floor is 50¢.
    const lastStep = { dataDay: '2026-10-01', fromCents: 40, toCents: 50 }
    const first = decide(base({ lastStep, restore: { layer: 'min_bid_hour', heldCents: 3, beforeCents: 50 } }))
    expect(first).toMatchObject({ action: 'write', layer: 'restore', bidCents: 50 })
    expect(first.step).toEqual(lastStep)
    // The second window of the same data day: the same bid again (no 50 → 62 → 78 slide).
    const second = decide(base({ lastStep: first.step, restore: { layer: 'min_bid_hour', heldCents: 3, beforeCents: 50 } }))
    expect(second).toMatchObject({ layer: 'restore', bidCents: 50 })
    // A new data day: one step from the bid before.
    const next = decide(base({ dataDay: '2026-10-02', lastStep, restore: { layer: 'min_bid_hour', heldCents: 3, beforeCents: 50 } }))
    expect(next.bidCents).toBeGreaterThan(50)
    expect(next.bidCents).toBeLessThanOrEqual(63)
  })
})

describe('review 5 — the placement ceiling against the bid Amazon may still hold', () => {
  it('a lowering still in the queue: the ceiling is measured against today\'s higher bid', () => {
    const lanes: Lane[] = [{ lane: 'TOP_OF_SEARCH', planPct: 150, maxCpcCents: 60, dynamic: 1 }]
    const f = { ...facts({ targetId: 't1', currentCents: 40 }), lanes, planNote: 'hourly plan P: all-out' }
    const cut = { targetId: 't1', action: 'write', layer: 'goal', currentCents: 40, bidCents: 20 } as Decision
    const [w] = placementWrites({ market: 'IT', campaigns: new Map([['c1', { id: 'c1', status: 'ENABLED', placements: [] } as never]]) }, [f], [cut], new Set(['c1']), () => 'c1', new Map([['c1', { scheduleId: 's1', name: 'P', key: 'all-out', spec: null, event: null }]]))
    expect(w.maxBidCents).toBe(40)
    expect(placementPlan(w)!.adjustments).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 50 }])
  })
})

describe('live fix 10-08 — a Min-bid hour zeroes the placements in the same tick as the keyword floors', () => {
  const campaigns = new Map([['c1', { id: 'c1', status: 'ENABLED', biddingStrategy: 'AUTO_FOR_SALES', placements: [{ placement: 'PLACEMENT_TOP', percentage: 300 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 75 }] } as never]])
  const plan = (s: RankTargetSpec) => new Map([['c1', hour(s)]])
  const tick = (s: RankTargetSpec, current: number, entries = flap) => {
    const p = planFacts(hour(s), { biddingStrategy: 'AUTO_FOR_SALES' }, entries)!
    const f = { ...facts({ targetId: 't1', currentCents: current, overrides: p.minBidHour ? { minBidHour: p.minBidHour } : {} }), ...(p.lanes.length ? { lanes: p.lanes } : {}), planNote: p.note }
    const d = decide(f)
    return { d, writes: placementWrites({ market: 'IT', campaigns }, [f], [d], new Set(['c1']), () => 'c1', plan(s)) }
  }

  it('the keyword to its 3¢ floor and every placement to 0 % in one tick (AB-2: the stop recipe\'s lanes, its memory saved first)', () => {
    const { d, writes } = tick(spec({ key: 'min', pause: true, floorBidCents: 3 }), 40)
    expect(d).toMatchObject({ action: 'write', layer: 'min_bid_hour', bidCents: 3 })
    expect(writes).toHaveLength(1)
    const p = placementPlan(writes[0])!
    expect(p.adjustments).toEqual([
      { placement: 'PLACEMENT_TOP', percentage: 0 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
      { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 },
    ])
    expect(p.changes).toEqual([
      { lane: 'top-of-search', from: 300, to: 0, held: null },
      { lane: 'product-page', from: 75, to: 0, held: null },
    ])
    expect(writes[0]).toMatchObject({ recipe: 'stop', note: 'hourly plan IT GALE JACKET: min — every placement at 0 %' })
  })

  it('the "kept serving" hour of the anti-flap writes no placement zero', () => {
    const { d, writes } = tick(spec({ key: 'min', pause: true, floorBidCents: 3 }), 40, { entriesToday: 2, inMinBid: false, maxEntries: 2 })
    expect(d.layer).not.toBe('min_bid_hour')
    expect(writes).toEqual([])
  })

  it('the serving hour after: a blended target sets all three lanes again; a single-placement one its own lane, the others staying at 0 % (said)', () => {
    const zeroed = new Map([['c1', { id: 'c1', status: 'ENABLED', biddingStrategy: 'LEGACY_FOR_SALES', placements: [{ placement: 'PLACEMENT_TOP', percentage: 0 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 }] } as never]])
    const serve = (s: RankTargetSpec) => {
      const p = planFacts(hour(s), { biddingStrategy: 'LEGACY_FOR_SALES' }, flap)!
      const f = { ...facts({ targetId: 't1', currentCents: 30 }), lanes: p.lanes, planNote: p.note }
      const [w] = placementWrites({ market: 'IT', campaigns: zeroed }, [f], [decide(f)], new Set(['c1']), () => 'c1', new Map([['c1', hour(s)]]))
      return placementPlan(w)!
    }
    const blended = serve(spec({ maxCpcCents: 200, lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 150 }, { placement: 'PLACEMENT_PRODUCT_PAGE', biasPct: 50 }] }))
    expect(blended.adjustments).toEqual([
      { placement: 'PLACEMENT_TOP', percentage: 150 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
      { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 50 },
    ])
    expect(blended.kept).toEqual([])
    const single = serve(spec({ maxCpcCents: 200, placement: 'PLACEMENT_TOP', biasPct: 120 }))
    expect(single.changes).toEqual([{ lane: 'top-of-search', from: 0, to: 120, held: null }])
    expect(single.kept).toEqual([{ lane: 'rest-of-search', pct: 0 }, { lane: 'product-page', pct: 0 }])
  })
})

describe('review 4 — a give-back is held inside today\'s limits', () => {
  it('to the strategy\'s highest bid and the plan\'s day ceiling, on a full run and on a tick with no goal', () => {
    const back = (over: Partial<TargetFacts>) => decide(facts({ currentCents: 3, overrides: {}, restore: { layer: 'min_bid_hour', heldCents: 3, beforeCents: 80 }, ...over }))
    expect(back({ limits: { maxChangePct: 25, maxBidCents: 60 } })).toMatchObject({ layer: 'restore', bidCents: 60 })
    expect(back({ limits: { maxChangePct: 25, planCeilingCents: 50 } })).toMatchObject({ layer: 'restore', bidCents: 50 })
    // A between-slots tick (no evidence, no goal): the bid before, clamped the same way.
    expect(back({ chain: [], limits: { planCeilingCents: 50 } })).toMatchObject({ layer: 'restore', bidCents: 50 })
    expect(back({ chain: [] })).toMatchObject({ layer: 'restore', bidCents: 80 })
  })
})
