/**
 * BID BRAIN BB-22 — the learned hour factors' maths (hour-factors.ts), on made-up hourly data (the repository is public:
 * round, invented counts only).
 *
 *   flag        NEXUS_BID_BRAIN_HOUR_FACTORS off · shadow (default, and anything unknown) · on
 *   spline      a cyclic cubic basis: a partition of unity, smooth across midnight
 *   shrink      a product with no orders keeps its market's conversion shape; one with plenty of its own moves away from
 *               it; a few orders move it a little, never to their raw rate; the curve is smoother than the raw rates;
 *               the same cells give the same curve
 *   cost        the plan's own uplift is not read as a dear hour; a Min-bid hour is left out of the cost
 *   factor      conversion ÷ cost, mean 1 over the traffic, with its interval
 *   the plan    painted factor null at Min-bid hours, the move asked = learned ÷ painted
 *   limits      clamp into [1 − hourCellMovePct, 1], never above the approved cell, a move under 10 % is none, an Owner-locked
 *               hour, a Min-bid hour, a dated event, a stale plan, an hour too uncertain, lanes at 0 %
 *   TOS cap     pooled to the market for a thin product, its own for a rich one, held inside the cell's limits
 *   capped days a capped UTC day leaves out the local days it touches; an arrivals cap leaves the rows whole
 */
import { describe, expect, it } from 'vitest'
import {
  byHourOfWeek, cappedLocalDays, cellMove, cyclicBasis, fitCurve, hourFactorMode, indexOf, laneLimits, laneShares, learnCurves, learnHourFactors,
  multiplierOf, planAgainst, planTargets, tosCap, type LearnInput,
} from './hour-factors.js'
import { localDayHour, type HourCell } from '../brain/hours-research.js'
import type { PaintTarget } from '../brain/hours-paint.js'

/** 28 local days (four of each weekday), oldest first. */
const DAYS = Array.from({ length: 28 }, (_, i) => new Date(Date.parse('2026-09-07T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10))

/**
 * Hourly cells: `clicks` an hour, conversion `cr(h)`, a click at `cpc(h)` cents. Orders are whole numbers, each hour of the
 * day carrying its own remainder over the days (so every hour converts at its own rate over the four weeks).
 */
function cells(clicks: number, cr: (h: number) => number, cpc: (h: number) => number = () => 40, days = DAYS): HourCell[] {
  const carry = Array.from({ length: 24 }, (_, h) => (h * 7 % 24) / 24)
  const out: HourCell[] = []
  for (const day of days) {
    for (let h = 0; h < 24; h++) {
      carry[h] += clicks * cr(h)
      const orders = Math.floor(carry[h] + 1e-9)
      carry[h] -= orders
      out.push({ day, hour: h, impressions: clicks * 30, clicks, spendCents: clicks * cpc(h), orders, salesCents: orders * 8000 })
    }
  }
  return out
}
const evening = (h: number) => h >= 18 && h < 22
const marketCr = (h: number) => (evening(h) ? 0.04 : 0.02)
/** The mean of an index over the hours of the day (all weekdays, equal weight). */
const atHours = (index: readonly number[], hours: (h: number) => boolean) => {
  const xs = index.filter((_, k) => hours(k % 24))
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

describe('BB-22 — the flag', () => {
  it('off · shadow (the default, and anything unknown) · on', () => {
    expect(hourFactorMode(undefined)).toBe('shadow')
    expect(hourFactorMode('')).toBe('shadow')
    expect(hourFactorMode('live')).toBe('shadow')
    expect(hourFactorMode('shadow')).toBe('shadow')
    for (const v of ['off', 'OFF', '0', 'false']) expect(hourFactorMode(v)).toBe('off')
    for (const v of ['on', 'On', '1', 'true']) expect(hourFactorMode(v)).toBe('on')
  })
})

describe('BB-22 — the cyclic spline', () => {
  it('sums to 1 at every hour and is smooth across midnight', () => {
    for (let h = 0; h < 24; h++) expect(cyclicBasis(h).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12)
    const late = cyclicBasis(23), early = cyclicBasis(0)
    // One hour apart across midnight moves the basis as little as one hour apart at midday.
    const gap = (a: number[], b: number[]) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0)
    expect(gap(late, early)).toBeCloseTo(gap(cyclicBasis(11), cyclicBasis(12)), 10)
    expect(cyclicBasis(0)).toHaveLength(6)
  })
})

describe('BB-22 — the conversion curve, pooled and shrunk', () => {
  const market = cells(100, marketCr)

  it('a product with no orders keeps its market\'s shape', () => {
    const c = learnCurves({ market, category: null, product: cells(2, () => 0) })
    const ratio = atHours(c.cr, evening) / atHours(c.cr, (h) => !evening(h))
    expect(ratio).toBeGreaterThan(1.6)
    expect(ratio).toBeLessThan(2.2)
  })

  it('a product with plenty of its own orders moves away from the market (it sells at night)', () => {
    const night = (h: number) => h < 6
    const c = learnCurves({ market, category: null, product: cells(200, (h) => (night(h) ? 0.05 : 0.02)) })
    const m = learnCurves({ market, category: null, product: cells(2, () => 0) })
    expect(atHours(c.cr, night)).toBeGreaterThan(1.5 * atHours(m.cr, night))
    expect(atHours(c.cr, night) / atHours(c.cr, (h) => h >= 8 && h < 16)).toBeGreaterThan(1.8)
  })

  it('a few orders move the product a little, never to their raw rate', () => {
    // Three orders, all at 03:00 on Mondays: the raw rate there is far above every other hour.
    const product = cells(3, () => 0).map((c) => (c.hour === 3 && new Date(`${c.day}T00:00:00Z`).getUTCDay() === 1 && c.day <= DAYS[20] ? { ...c, orders: 1 } : c))
    const c = learnCurves({ market, category: null, product })
    const k = 1 * 24 + 3
    expect(c.cr[k]).toBeGreaterThan(atHours(learnCurves({ market, category: null, product: cells(3, () => 0) }).cr, (h) => h === 3))
    // Raw: 3 orders from 12 clicks at Monday 03:00 against none elsewhere — an index in the dozens; shrunk: below 3.
    expect(c.cr[k]).toBeLessThan(3)
  })

  it('the category stands between the market and the product', () => {
    const category = cells(60, (h) => (h >= 8 && h < 12 ? 0.05 : 0.02))
    const c = learnCurves({ market, category, product: cells(1, () => 0) })
    const morning = (h: number) => h >= 8 && h < 12
    // The product (no orders) takes its category's morning, not the market's evening.
    expect(atHours(c.cr, morning)).toBeGreaterThan(atHours(c.cr, evening))
  })

  it('is smoother than the raw rates, and the same cells give the same curve', () => {
    // A noisy product: every other hour converts twice as well.
    const product = cells(80, (h) => (h % 2 ? 0.04 : 0.02))
    const c = learnCurves({ market, category: null, product })
    const b = byHourOfWeek(product)
    const raw = b.orders.map((o, k) => (b.clicks[k] > 0 ? o / b.clicks[k] : 0))
    const rough = (xs: readonly number[]) => xs.reduce((s, x, k) => s + Math.abs(x - xs[(k + 1) % 168]), 0) / xs.reduce((s, x) => s + x, 0)
    expect(rough(c.cr)).toBeLessThan(rough(raw) / 3)
    expect(JSON.stringify(learnCurves({ market, category: null, product }))).toBe(JSON.stringify(c))
  })

  it('a fit with no data at all is the prior, with the prior\'s spread', () => {
    const zeros = Array.from({ length: 168 }, () => 0)
    const f = fitCurve({ y: zeros, e: zeros, weights: zeros.map(() => 1) })
    expect(f.log.every((x) => x === 0)).toBe(true)
    expect(Math.sqrt(Math.max(...f.variance))).toBeGreaterThan(0.2)
    expect(indexOf(f.log, zeros.map(() => 1)).every((x) => Math.abs(x - 1) < 1e-12)).toBe(true)
  })
})

describe('BB-22 — what a click costs per unit of bid', () => {
  const market = cells(100, () => 0.02, () => 40)
  const lifted = (h: number) => h >= 16 && h < 22

  it('the plan\'s own uplift is not read as a dear hour', () => {
    // The plan doubles the bid 16–22: the product pays twice as much there for the same competition.
    const product = cells(50, () => 0.02, (h) => (lifted(h) ? 80 : 40))
    const raw = learnCurves({ market, category: null, product })
    const corrected = learnCurves({ market, category: null, product: product.map((c) => ({ ...c, m: lifted(c.hour) ? 2 : 1 })) })
    expect(atHours(raw.r, lifted) / atHours(raw.r, (h) => !lifted(h))).toBeGreaterThan(1.7)
    expect(atHours(corrected.r, lifted) / atHours(corrected.r, (h) => !lifted(h))).toBeCloseTo(1, 1)
    // Read raw, the brain would cut the plan's own hours; corrected, it does not.
    expect(atHours(raw.f, lifted)).toBeLessThan(0.7)
    expect(atHours(corrected.f, lifted)).toBeGreaterThan(0.9)
  })

  it('a Min-bid hour is left out of the cost (its cost is the floor\'s)', () => {
    const night = (h: number) => h < 6
    const product = cells(50, () => 0.02, (h) => (night(h) ? 3 : 40)).map((c) => ({ ...c, m: night(c.hour) ? null : 1 }))
    const c = learnCurves({ market, category: null, product })
    // The night keeps the market's cost (flat), not the floor's 3¢.
    expect(atHours(c.r, night) / atHours(c.r, (h) => !night(h))).toBeGreaterThan(0.8)
    expect(byHourOfWeek(product).costClicks[2]).toBe(0)
  })
})

describe('BB-22 — the factor', () => {
  it('conversion ÷ cost, mean 1 over the traffic, with its 90 % interval', () => {
    const market = cells(100, marketCr, (h) => (evening(h) ? 50 : 40))
    const c = learnCurves({ market, category: null, product: cells(60, marketCr, (h) => (evening(h) ? 50 : 40)) })
    const mean = c.f.reduce((s, x, k) => s + x * c.share[k], 0) / c.share.reduce((s, x) => s + x, 0)
    expect(mean).toBeCloseTo(1, 2)
    // Evening: twice the conversion at 1.25 × the cost → about 1.6 × the bid of the rest of the day.
    const ratio = atHours(c.f, evening) / atHours(c.f, (h) => !evening(h))
    expect(ratio).toBeGreaterThan(1.3)
    expect(ratio).toBeLessThan(1.9)
    for (let k = 0; k < 168; k++) {
      expect(c.lo[k]).toBeLessThanOrEqual(c.f[k])
      expect(c.hi[k]).toBeGreaterThanOrEqual(c.f[k])
    }
  })
})

// ── The plan and the limits ──────────────────────────────────────────────────────────────────────────────────────

const T = (key: string, lanes: PaintTarget['lanes'], floor = false): PaintTarget => ({ key, name: key, floor, placementPct: Math.max(0, ...Object.values(lanes).map((x) => x ?? 0)), lanes, maxCpcCents: null })
const TARGETS = new Map<string, PaintTarget>([
  ['min', T('min', {}, true)],
  ['top', T('top', { TOP_OF_SEARCH: 100 })],
  ['rest', T('rest', { REST_OF_SEARCH: 0 })],
])
const PLAN = { windows: [{ startHour: 0, endHour: 6, targetKey: 'min' }, { startHour: 16, endHour: 22, targetKey: 'top' }], defaultTargetKey: 'rest' }

describe('BB-22 — the plan against the learned factor', () => {
  it('painted is null at Min-bid hours; the move asked is learned ÷ painted over the plan\'s serving hours', () => {
    const shares = laneShares([{ lane: 'TOP_OF_SEARCH', spendShare: 0.5 }, { lane: 'REST_OF_SEARCH', spendShare: 0.5 }])
    expect(multiplierOf(TARGETS.get('top'), shares)).toBeCloseTo(1.5, 10)
    expect(multiplierOf(TARGETS.get('min'), shares)).toBeNull()
    const flat = Array.from({ length: 168 }, () => 1)
    const plan = planAgainst({ f: flat, lo: flat, hi: flat, share: flat.map(() => 1 / 168) }, planTargets(PLAN, TARGETS), shares, { campaignId: 'c1', scheduleId: 's1', basis: 'b' })
    expect(plan.painted[2]).toBeNull()
    expect(plan.rho[2]).toBeNull()
    // Serving hours: 6 at ×1.5, 12 at ×1 → mean 1.1667; the lifted hour paints 1.2857, the rest 0.8571.
    expect(plan.painted[18]).toBeCloseTo(1.5 / (6 * 1.5 + 12) * 18, 3)
    expect(plan.painted[10]).toBeCloseTo(1 / (6 * 1.5 + 12) * 18, 3)
    // A flat learned factor asks the lifted hours down and the plain hours up (the limits will hold the raise).
    expect(plan.rho[18]!).toBeLessThan(0.8)
    expect(plan.rho[10]!).toBeGreaterThan(1.1)
  })
})

describe('BB-22 — one cell inside its limits', () => {
  const base = { d: 2, h: 14, floor: false, movePct: 30, rho: 0.5, rhoLo: 0.4, rhoHi: 0.7, learned: 0.6, painted: 1.2 }

  it('lane limits: the approved % is the ceiling, movePct of the bid multiplier below it the floor (never below 0 %)', () => {
    expect(laneLimits(300, 30)).toEqual({ min: 180, max: 300 })
    expect(laneLimits(100, 30)).toEqual({ min: 40, max: 100 })
    expect(laneLimits(20, 30)).toEqual({ min: 0, max: 20 })
    expect(laneLimits(0, 30)).toEqual({ min: 0, max: 0 })
    expect(laneLimits(150, 0)).toEqual({ min: 150, max: 150 })
  })

  it('clamped to the cell\'s floor: asked ×0.5, moved ×0.7, top of search 100 → 40 %', () => {
    const m = cellMove({ ...base, lanes: [{ lane: 'TOP_OF_SEARCH', pct: 100 }] })
    expect(m).toMatchObject({ status: 'moved', cell: 'd2h14', scale: 0.7, asked: 0.5, capped: false })
    expect(m.lanes).toEqual([{ lane: 'TOP_OF_SEARCH', from: 100, to: 40, min: 40, max: 100 }])
    expect(m.words).toMatch(/^Tue 14:00: learned ×0\.60 against the plan's ×1\.20 → asks ×0\.50 of the cell; 90 %: ×0\.40–×0\.70 — ×0\.70 \(held at the cell's floor, 30 % below the approved\): top-of-search 100 → 40 % \(limits 40–100 %\)$/)
  })

  it('inside the limits it moves as asked; every lane the cell declares, a lane at 0 % stays 0 %', () => {
    const m = cellMove({ ...base, rho: 0.8, rhoLo: 0.7, rhoHi: 0.9, lanes: [{ lane: 'TOP_OF_SEARCH', pct: 150 }, { lane: 'PRODUCT_PAGE', pct: 50 }, { lane: 'REST_OF_SEARCH', pct: 0 }] })
    expect(m.status).toBe('moved')
    expect(m.lanes.map((l) => [l.lane, l.to])).toEqual([['TOP_OF_SEARCH', 100], ['PRODUCT_PAGE', 20], ['REST_OF_SEARCH', 0]])
  })

  it('never above the approved cell; a move under 10 % is none', () => {
    const lanes = [{ lane: 'TOP_OF_SEARCH' as const, pct: 100 }]
    const up = cellMove({ ...base, rho: 1.6, rhoLo: 1.3, rhoHi: 2, lanes })
    expect(up).toMatchObject({ status: 'kept', scale: 1 })
    expect(up.lanes[0].to).toBe(100)
    expect(up.words).toMatch(/kept: never above the approved cell$/)
    const small = cellMove({ ...base, rho: 0.93, rhoLo: 0.85, rhoHi: 1.02, lanes })
    expect(small).toMatchObject({ status: 'kept', scale: 1 })
    expect(small.words).toMatch(/kept: under the 10 % a move needs$/)
  })

  it('an Owner-locked hour, a Min-bid hour, a dated event, a stale plan, no target, nothing learned: never changed', () => {
    const lanes = [{ lane: 'TOP_OF_SEARCH' as const, pct: 100 }]
    expect(cellMove({ ...base, lanes, locked: true })).toMatchObject({ status: 'locked', scale: 1, lanes: [{ from: 100, to: 100 }] })
    expect(cellMove({ ...base, lanes: [], floor: true })).toMatchObject({ status: 'min_bid', lanes: [] })
    expect(cellMove({ ...base, lanes, event: 'Black Friday' })).toMatchObject({ status: 'event', lanes: [{ to: 100 }] })
    expect(cellMove({ ...base, lanes, stale: 'the plan changed' })).toMatchObject({ status: 'stale', lanes: [{ to: 100 }] })
    expect(cellMove({ ...base, lanes: [], noTarget: true })).toMatchObject({ status: 'no_target' })
    expect(cellMove({ ...base, lanes, rho: null })).toMatchObject({ status: 'not_learned', lanes: [{ to: 100 }] })
    expect(cellMove({ ...base, lanes, locked: true }).words).toMatch(/an hour the Owner locked \(d2h14\) — never changed/)
  })

  it('an hour too uncertain to tell stays; movePct 0 lets nothing move; every lane at 0 % cannot go lower', () => {
    const lanes = [{ lane: 'TOP_OF_SEARCH' as const, pct: 100 }]
    expect(cellMove({ ...base, lanes, rhoLo: 0.2, rhoHi: 1.2 })).toMatchObject({ status: 'uncertain', scale: 1, lanes: [{ to: 100 }] })
    expect(cellMove({ ...base, lanes, movePct: 0 }).words).toMatch(/kept: hourCellMovePct is 0/)
    const zero = cellMove({ ...base, lanes: [{ lane: 'REST_OF_SEARCH', pct: 0 }] })
    expect(zero).toMatchObject({ status: 'kept' })
    expect(zero.words).toMatch(/every lane it declares is at 0 %/)
  })

  it('the top-of-search cap holds the lane lower, inside the cell\'s limits', () => {
    const lanes = [{ lane: 'TOP_OF_SEARCH' as const, pct: 300 }, { lane: 'PRODUCT_PAGE' as const, pct: 50 }]
    const kept = { ...base, rho: 1, rhoLo: 0.9, rhoHi: 1.1 }
    const capped = cellMove({ ...kept, lanes, tosCapPct: 250, tosRatio: 0.8 })
    expect(capped).toMatchObject({ status: 'moved', capped: true })
    expect(capped.lanes.map((l) => l.to)).toEqual([250, 50])
    expect(capped.words).toMatch(/top-of-search cap 250 % \(top of search converts ×0\.80 the other placements, pooled\)/)
    // A cap below the cell's floor (180 %) is held there: the plan's limit wins.
    expect(cellMove({ ...kept, lanes, tosCapPct: 0 }).lanes.map((l) => l.to)).toEqual([180, 50])
    // A cap above the approved % does nothing.
    expect(cellMove({ ...kept, lanes, tosCapPct: 400 })).toMatchObject({ status: 'kept', capped: false })
  })
})

describe('BB-22 — top of search\'s conversion cap', () => {
  const goal = { aim: 0.2, hi: 0.28 }
  const market = { tosOrders: 30, tosClicks: 2000, orders: 100, clicks: 5000 } // the market's TOS converts ×0.75

  it('a thin product takes the market\'s ratio; a rich one its own', () => {
    const thin = tosCap({ tosOrders: 0, tosClicks: 20, orders: 1, clicks: 60 }, market, goal)!
    expect(thin.marketRatio).toBe(0.75)
    expect(thin.ratio).toBeGreaterThan(0.6)
    expect(thin.ratio).toBeLessThan(0.8)
    const rich = tosCap({ tosOrders: 60, tosClicks: 1000, orders: 80, clicks: 4000 }, market, goal)!
    // Its own: 6 % at top of search against 2 % overall = ×3, pulled toward the market's ×0.75 with 5 orders of weight:
    // (60 + 5) ÷ (1,000 × 2 % + 5 ÷ 0.75).
    expect(rich.ratio).toBeCloseTo(65 / (20 + 5 / 0.75), 4)
    expect(rich.ratio).toBeGreaterThan(2)
    expect(rich.capPct).toBe(Math.floor((rich.ratio * 0.28 / 0.2 - 1) * 100))
  })

  it('the cap: 1 + p ≤ ratio × band top ÷ aim; none without a goal; none without any placement data', () => {
    const c = tosCap(null, market, goal)!
    expect(c.ratio).toBe(0.75)
    expect(c.capPct).toBe(5) // 0.75 × 1.4 = 1.05
    expect(tosCap(null, market, null)!.capPct).toBeNull()
    expect(tosCap(null, null, goal)).toBeNull()
  })
})

describe('BB-22 — capped days', () => {
  it('a capped UTC day leaves out the local days it touches; an arrivals cap leaves the rows whole', () => {
    const rome = (at: Date) => localDayHour(at, 'Europe/Rome').day
    expect(cappedLocalDays([{ date: '2026-09-20', kind: 'rows' }], rome).map((x) => x.day)).toEqual(['2026-09-20', '2026-09-21'])
    expect(cappedLocalDays([{ date: '2026-09-20', kind: 'arrivals' }], rome)).toEqual([])
    const ny = (at: Date) => localDayHour(at, 'America/New_York').day
    expect(cappedLocalDays([{ date: '2026-09-20', kind: 'rows' }], ny).map((x) => x.day)).toEqual(['2026-09-19', '2026-09-20'])
    expect(cappedLocalDays([{ date: '2026-09-20', kind: 'rows' }], rome)[0].why).toMatch(/capped on 2026-09-20/)
  })
})

describe('BB-22 — one product\'s learning', () => {
  it('learns curves, plans, the cap and words with no money in them', () => {
    const shares = laneShares([{ lane: 'TOP_OF_SEARCH', spendShare: 0.6 }, { lane: 'REST_OF_SEARCH', spendShare: 0.4 }])
    const week = planTargets(PLAN, TARGETS)
    const product = cells(40, marketCr).map((c) => {
      const t = week[new Date(`${c.day}T00:00:00Z`).getUTCDay()][c.hour]
      return { ...c, m: multiplierOf(t, shares) }
    })
    const input: LearnInput = {
      productId: 'p1', market: 'IT', timeZone: 'Europe/Rome', days: DAYS, leftOut: [{ day: '2026-10-05', why: 'the dated event "Sale"' }],
      pools: { market: cells(100, marketCr), category: null },
      campaigns: [{ campaignId: 'c1', scheduleId: 's1', basis: 'b1', cells: product, week }],
      shares, lanes: { product: { tosOrders: 10, tosClicks: 600, orders: 30, clicks: 1200 }, market: { tosOrders: 30, tosClicks: 2000, orders: 100, clicks: 5000 } },
      goal: { aim: 0.2, hi: 0.28 }, confidence: { label: 'medium', thin: false, ordersPer30d: 20, words: 'Medium confidence.' },
    }
    const l = learnHourFactors(input)
    expect(l).toMatchObject({ version: 1, productId: 'p1', market: 'IT', window: { from: DAYS[0], to: DAYS[27], days: 28 } })
    for (const key of ['f', 'lo', 'hi', 'cr', 'crSd', 'r', 'rSd', 'share'] as const) expect(l.curves[key]).toHaveLength(168)
    expect(l.plans).toHaveLength(1)
    expect(l.plans[0].painted.filter((x) => x == null)).toHaveLength(42) // 6 Min-bid hours × 7 days
    expect(l.tos!.capPct).not.toBeNull()
    expect(l.evidence.floorCells).toBe(6 * 28)
    expect(l.summary.join(' ')).toMatch(/Conversion \(pooled\) is best 16–20/)
    expect(l.summary.join(' ')).toMatch(/Left out: 1 day \(the dated event "Sale"\)/)
    expect(l.summary.join(' ')).not.toMatch(/€|cents|spend|cost per click \d/)
    expect(JSON.stringify(learnHourFactors(input))).toBe(JSON.stringify(l))
  })
})
