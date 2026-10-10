/**
 * BID BRAIN BB-19 — the bid response (response.ts), pure.
 *
 *   fit        a move's difference in differences reads a known ε back from made-up clicks; with a control it removes
 *              the trend every keyword shared; many noisy moves of a made-up product with ε 0.6 land near 0.6, few stay
 *              near the prior
 *   pooling    no move: exactly the prior Gamma(0.8, 0.4); the market learns from the OTHER products, the product from its
 *              own; a measured ε takes no lean; top-of-search share leans an unmeasured one
 *   profit     b* = ε/(1+ε) · v · BE ÷ r̂, its marginal ACoS is break-even and its average BE · ε/(1+ε); held inside the band
 *              and under break-even; GROW's bid has a marginal ACoS of the band top; none in LAUNCH or without break-even;
 *              a capped campaign's never above today's bid
 *   mACoS      ACoS · (1 + ε)/ε — the slope of spend over sales on the response curve
 *   tail       the goal's tail here gives exactly decide.ts's goal bid (the replication is pinned)
 *   moves      matched days, the move's day left out, a control without the keywords that moved, too short a gap refused
 *
 * Made-up numbers only (the repository is public).
 */
import { describe, expect, it } from 'vitest'
import { decide, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import { bidForAcos } from './recipe.js'
import {
  EPS_PRIOR_MEAN, EPS_PRIOR_SD, combineReadings, goalContext, goalTail, keywordEps, marginalAcos, moveEventsOf, moveReading,
  productEps, profitBestBid, responseFor, responseMode, summarizeResponse, tosLean, TOS_MIN_DAYS, type EpsPosterior, type MoveEvent,
} from './response.js'

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
/** A Poisson draw (Knuth for small means, normal above). */
function poisson(mean: number, r: () => number): number {
  if (mean > 50) return Math.max(0, Math.round(mean + Math.sqrt(mean) * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())))
  const l = Math.exp(-mean)
  let k = 0
  let p = 1
  do { k++; p *= r() } while (p > l)
  return k - 1
}

const move = (over: Partial<MoveEvent>): MoveEvent => ({
  targetId: 'kw', productKey: 'jacket', beforeCents: 20, afterCents: 25, days: 7, clicksBefore: 100, clicksAfter: 100, control: null, ...over,
})

describe('responseMode', () => {
  it('is shadow unless switched off — there is no on', () => {
    expect(responseMode(undefined)).toBe('shadow')
    expect(responseMode('on')).toBe('shadow')
    expect(responseMode('live')).toBe('shadow')
    expect(responseMode('off')).toBe('off')
    expect(responseMode(' FALSE ')).toBe('off')
  })
})

describe('the fit reads a known ε', () => {
  it('one exact move: ln(clicks ratio) ÷ ln(bid ratio)', () => {
    // ε 0.6: a 25 % raise buys 1.25^0.6 = 14.3 % more clicks.
    const before = 2000
    const after = before * Math.pow(1.25, 0.6)
    const r = moveReading(move({ clicksBefore: before, clicksAfter: after }))!
    expect(r.eps).toBeCloseTo(0.6, 2)
    // A cut reads the same way.
    const cut = moveReading(move({ beforeCents: 25, afterCents: 20, clicksBefore: after, clicksAfter: before }))!
    expect(cut.eps).toBeCloseTo(0.6, 2)
  })

  it('the control removes what every keyword shared (a season lifting all clicks 20 %)', () => {
    const before = 2000
    const after = before * Math.pow(1.25, 0.6) * 1.2
    expect(moveReading(move({ clicksBefore: before, clicksAfter: after }))!.eps).toBeGreaterThan(1)
    const r = moveReading(move({ clicksBefore: before, clicksAfter: after, control: { before: 5000, after: 6000 } }))!
    expect(r.eps).toBeCloseTo(0.6, 2)
  })

  it('a move under 10 % or with under 3 matched days is no reading; few clicks are a wide one', () => {
    expect(moveReading(move({ beforeCents: 20, afterCents: 21 }))).toBeNull()
    expect(moveReading(move({ days: 2 }))).toBeNull()
    expect(moveReading(move({ beforeCents: 0 }))).toBeNull()
    const thin = moveReading(move({ clicksBefore: 3, clicksAfter: 4 }))!
    const thick = moveReading(move({ clicksBefore: 3000, clicksAfter: 4000 }))!
    expect(thin.variance).toBeGreaterThan(50 * thick.variance)
  })

  it('many noisy moves of a made-up product with ε 0.6 land near 0.6; three stay near the prior', () => {
    const r = rng(7)
    const truth = 0.6
    const events: MoveEvent[] = []
    for (let i = 0; i < 400; i++) {
      const before = 10 + Math.floor(r() * 40)
      const up = r() < 0.5
      const after = Math.round(before * (up ? 1.1 + r() * 0.4 : 1 / (1.1 + r() * 0.4)))
      const base = 40 + r() * 60
      const season = 0.8 + r() * 0.4
      events.push(move({
        targetId: `kw${i}`, beforeCents: before, afterCents: after,
        clicksBefore: poisson(base, r), clicksAfter: poisson(base * season * Math.pow(after / before, truth), r),
        control: { before: poisson(base * 4, r), after: poisson(base * 4 * season, r) },
      }))
    }
    const many = productEps(new Map([['jacket', events]]), 'jacket')
    expect(many.mean).toBeGreaterThan(0.5)
    expect(many.mean).toBeLessThan(0.7)
    expect(many.measured).toBe(true)
    // A few made-up moves round to under 10 % and are no reading.
    expect(many.ownMoves).toBeGreaterThan(300)
    const few = productEps(new Map([['jacket', events.slice(0, 3)]]), 'jacket')
    expect(Math.abs(few.mean - EPS_PRIOR_MEAN)).toBeLessThan(0.25)
    expect(few.measured).toBe(false)
  })

  it('combines readings by their precision', () => {
    expect(combineReadings([{ eps: 1, variance: 1 }, { eps: 0, variance: 1 }])).toEqual({ eps: 0.5, variance: 0.5 })
    expect(combineReadings([null])).toBeNull()
  })
})

describe('pooling market → product', () => {
  const exact = (eps: number, key: string, n: number, clicks = 4000): MoveEvent[] => Array.from({ length: n }, (_, i) => move({
    targetId: `${key}${i}`, productKey: key, clicksBefore: clicks, clicksAfter: clicks * Math.pow(1.25, eps),
  }))

  it('no move anywhere: exactly the prior, said so', () => {
    const p = productEps(new Map(), 'jacket')
    expect(p.mean).toBeCloseTo(EPS_PRIOR_MEAN, 10)
    expect(p.sd).toBeCloseTo(EPS_PRIOR_SD, 10)
    expect(p).toMatchObject({ ownMoves: 0, marketMoves: 0, measured: false, from: 'prior' })
  })

  it('the market learns from the other products; the product from its own, never counting one twice', () => {
    const others = new Map([['gloves', exact(0.3, 'gloves', 30)], ['boots', exact(0.3, 'boots', 30)]])
    const jacket = productEps(others, 'jacket')
    expect(jacket.mean).toBeLessThan(0.6)
    expect(jacket.mean).toBeGreaterThan(0.3)
    expect(jacket.measured).toBe(false)
    expect(jacket).toMatchObject({ ownMoves: 0, marketMoves: 60 })
    // The gloves' own moves are not also read as the market's.
    const gloves = productEps(others, 'gloves')
    expect(gloves.ownMoves).toBe(30)
    expect(gloves.marketMoves).toBe(30)
    expect(gloves.mean).toBeCloseTo(0.3, 1)
  })

  it('top-of-search share leans an unmeasured ε; a measured one is left as measured', () => {
    const prior = productEps(new Map(), 'jacket')
    expect(tosLean({ tosShare: 0.62, tosDays: 14, cappedDays: 0 }, 0.85)).toMatchObject({ lean: 0.7 })
    expect(tosLean({ tosShare: 0.08, tosDays: 14, cappedDays: 0 }, 0.95)).toMatchObject({ lean: 1.25 })
    expect(tosLean({ tosShare: 0.08, tosDays: 14, cappedDays: 0 }, 0.7)).toMatchObject({ lean: 1, words: null })
    expect(tosLean(null, 0.95)).toMatchObject({ lean: 1 })
    const leaned = keywordEps(prior, { tosShare: 0.62, tosDays: 14, cappedDays: 0 }, 0.85)
    expect(leaned.mean).toBeCloseTo(0.56, 6)
    expect(leaned.from).toMatch(/^prior; campaign top-of-search IS 62% \(14 days\) → inelastic$/)
    const measured: EpsPosterior = { ...prior, mean: 0.4, sd: 0.1, measured: true }
    expect(keywordEps(measured, { tosShare: 0.62, tosDays: 14, cappedDays: 0 }, 0.85)).toBe(measured)
  })

  it('🔴 A5 — fewer than 7 days of the campaign\'s top-of-search IS lean nothing (one day used to lean every keyword)', () => {
    const prior = productEps(new Map(), 'jacket')
    expect(TOS_MIN_DAYS).toBe(7)
    for (const tosDays of [1, 6]) {
      expect(tosLean({ tosShare: 0.62, tosDays, cappedDays: 0 }, 0.85)).toEqual({ lean: 1, words: null })
      expect(tosLean({ tosShare: 0.08, tosDays, cappedDays: 0 }, 0.95)).toEqual({ lean: 1, words: null })
      expect(keywordEps(prior, { tosShare: 0.62, tosDays, cappedDays: 0 }, 0.85)).toBe(prior)
    }
    expect(tosLean({ tosShare: 0.62, tosDays: 7, cappedDays: 0 }, 0.85)).toEqual({ lean: 0.7, words: 'campaign top-of-search IS 62% (7 days) → inelastic' })
    expect(tosLean({ tosShare: 0.08, tosDays: 7, cappedDays: 0 }, 0.95)).toEqual({ lean: 1.25, words: 'campaign top-of-search IS 8% (7 days) at CPC/bid 0.95 → bid-limited' })
  })
})

describe('the profit-best bid and the marginal ACoS', () => {
  // A made-up jacket: CR 1 %, order value 8,000¢, paid CPC = 0.85 × bid, break-even 40 %.
  const base = { cr: 0.01, aovCents: 8000, ratio: 0.85, breakEven: 0.4, eps: 0.8, currentCents: 30, capped: false }
  const v = base.cr * base.aovCents
  const wide = { lo: 0.05, hi: 0.4, phase: 'PROFIT' as const }

  it('b* = ε/(1+ε) · v · BE ÷ r̂: its marginal ACoS is break-even, its average BE · ε/(1+ε)', () => {
    const p = profitBestBid({ ...base, goal: wide })
    const bStar = (0.8 / 1.8) * v * 0.4 / 0.85
    expect(p.rawCents).toBeCloseTo(bStar, 9)
    expect(p.cents).toBeCloseTo(bStar, 9)
    expect(p.held).toBeNull()
    const avg = (bStar * 0.85) / v
    expect(avg).toBeCloseTo(0.4 * (0.8 / 1.8), 9)
    expect(marginalAcos(avg, 0.8)).toBeCloseTo(0.4, 9)
  })

  it('is the highest profit of the response curve (a scan agrees)', () => {
    const profit = (b: number) => Math.pow(b, 0.8) * (v * 0.4 - 0.85 * b)
    const p = profitBestBid({ ...base, goal: wide })
    let best = 0
    for (let b = 0.1; b < 40; b += 0.01) if (profit(b) > profit(best)) best = b
    expect(p.cents!).toBeCloseTo(best, 1)
  })

  it('stays inside the band and under break-even', () => {
    // A band whose bottom sits above b*: held at the band bottom.
    const atBottom = profitBestBid({ ...base, goal: { lo: 0.25, hi: 0.4, phase: 'PROFIT' } })
    expect(atBottom.cents).toBeCloseTo(bidForAcos(0.25, 0.01, 8000, 0.85), 9)
    expect(atBottom.held).toBe('the band bottom 25%')
    // A near-inelastic market wants a bid near nothing → the band bottom; a very elastic one near break-even → its top.
    const elastic = profitBestBid({ ...base, eps: 2.9, goal: { lo: 0.05, hi: 0.2, phase: 'PROFIT' } })
    expect(elastic.cents).toBeCloseTo(bidForAcos(0.2, 0.01, 8000, 0.85), 9)
    expect(elastic.held).toBe('the band top 20%')
    // b* itself always sits under the break-even bid (ε/(1+ε) < 1); GROW with a band top above break-even does not.
    expect(profitBestBid({ ...base, eps: 2.9, breakEven: 0.3, goal: { lo: 0.05, hi: 0.5, phase: 'PROFIT' } }).cents!).toBeLessThan(bidForAcos(0.3, 0.01, 8000, 0.85))
    const be = profitBestBid({ ...base, eps: 2.9, breakEven: 0.3, goal: { lo: 0.05, hi: 0.5, phase: 'GROW' } })
    expect(be.cents).toBeCloseTo(bidForAcos(0.3, 0.01, 8000, 0.85), 9)
    expect(be.held).toBe('break-even 30%')
  })

  it('GROW: the highest bid whose marginal ACoS stays at the band top', () => {
    const p = profitBestBid({ ...base, breakEven: null, goal: { lo: 0.05, hi: 0.3, phase: 'GROW' } })
    const acos = (p.cents! * 0.85) / v
    expect(marginalAcos(acos, 0.8)).toBeCloseTo(0.3, 9)
  })

  it('none in LAUNCH, CLEAR_STOCK and DEFEND, and none in PROFIT without break-even', () => {
    for (const phase of ['LAUNCH', 'CLEAR_STOCK', 'DEFEND'] as const) {
      expect(profitBestBid({ ...base, goal: { ...wide, phase } })).toMatchObject({ cents: null, none: `${phase}: the goal's own aim decides` })
    }
    expect(profitBestBid({ ...base, breakEven: null, goal: wide })).toMatchObject({ cents: null, none: 'no break-even known (no profit data)' })
    expect(profitBestBid({ ...base, goal: { ...wide, phase: null } }).cents).not.toBeNull()
  })

  it('a budget-capped campaign: a raise buys no clicks, so never above today', () => {
    const p = profitBestBid({ ...base, eps: 2.9, currentCents: 20, capped: true, goal: wide })
    expect(p.cents).toBe(20)
    expect(p.held).toBe('budget capped: a raise buys no clicks')
    // A cut still goes where b* is.
    const cut = profitBestBid({ ...base, currentCents: 30, capped: true, goal: wide })
    expect(cut.cents).toBeCloseTo((0.8 / 1.8) * v * 0.4 / 0.85, 9)
  })

  it('mACoS = ACoS · (1 + ε)/ε is the slope of spend over sales on the curve', () => {
    const eps = 0.7
    const spend = (b: number) => Math.pow(b, eps) * 0.85 * b
    const sales = (b: number) => Math.pow(b, eps) * v
    for (const b of [10, 20, 35]) {
      const h = 1e-4
      const slope = (spend(b + h) - spend(b)) / (sales(b + h) - sales(b))
      expect(marginalAcos(spend(b) / sales(b), eps)).toBeCloseTo(slope, 5)
    }
    expect(marginalAcos(0.2, 0)).toBeNull()
    expect(marginalAcos(null, 0.8)).toBeNull()
  })
})

/** Worked facts on a made-up 1 % rate, with and without break-even, thin and thick, at a spread of bids. */
function spread(): TargetFacts[] {
  const out: TargetFacts[] = []
  const base = (current: number, extra: Partial<TargetFacts> = {}): TargetFacts => ({
    targetId: `kw-${current}-${out.length}`, currentCents: current, dataDay: '2026-09-29',
    chain: [{ level: 'target', evidence: ev(1, 0, 0, 30) }, { level: 'product', evidence: ev(2000, 20, 160_000, 60_000) }, { level: 'market', evidence: ev(9000, 90, 720_000, 270_000) }],
    listPriceCents: 9000, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT', breakEvenAcos: 0.35 },
    limits: { maxBidCents: 80, maxChangePct: 25 },
    ...extra,
  })
  for (const c of [5, 8, 14, 16, 19, 22, 25, 33, 45, 60, 90]) out.push(base(c))
  for (const c of [8, 16, 33]) out.push(base(c, { chain: [{ level: 'target', evidence: ev(160, 6, 48_000, 2240) }, { level: 'product', evidence: ev(2000, 20, 160_000, 60_000) }], limits: { maxChangePct: 100 } }))
  out.push(base(25, { lastStep: { dataDay: '2026-09-29', fromCents: 33, toCents: 25 } }))
  out.push(base(14, { directives: [{ kind: 'CEILING', cents: 12, source: 'rule:A' }, { kind: 'FLOOR', cents: 15, source: 'rule:B' }] }))
  out.push(base(20, { hourFactor: 0.8 }))
  out.push(base(20, { goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'GROW' } }))
  out.push(base(20, { goal: { target: { kind: 'ACOS', pct: 20 }, phase: 'LAUNCH', launchDay: 3, breakEvenAcos: 0.3 } }))
  out.push(base(20, { lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 300, maxCpcCents: 55 }], ratioCeiling: 4 }))
  return out
}

describe('the goal\'s tail is decide.ts\'s', () => {
  it('the aim\'s bid through goalTail is the decision\'s goal bid, keyword for keyword', () => {
    let compared = 0
    for (const f of spread()) {
      const d = decide(f)
      const ctx = goalContext(f)
      if (!ctx || d.goalBidCents == null) continue
      const parent = ctx.est.parent
      const want = bidForAcos(ctx.goal.aim, ctx.est.node.cr, ctx.aov, ctx.ratio)
      const parentWant = parent?.aovCents ? bidForAcos(ctx.goal.aim, parent.cr, parent.aovCents, ctx.ratio) : null
      expect(goalTail(ctx, f, want, parentWant), f.targetId).toBe(d.goalBidCents)
      compared += 1
    }
    expect(compared).toBeGreaterThan(15)
  })
})

describe('responseFor', () => {
  const prior = productEps(new Map(), 'jacket')

  it('logs the profit-best bid beside the goal\'s and the marginal ACoS — the decision itself is untouched', () => {
    for (const f of spread()) {
      const d = decide(f)
      const before = JSON.stringify(d)
      const n = responseFor(f, d, prior, null)
      expect(JSON.stringify(d)).toBe(before)
      if (!n) { expect(['goal', 'band', 'limit'].includes(d.layer) && d.goalBidCents != null).toBe(false); continue }
      expect(n.goalBidCents).toBe(d.goalBidCents)
      if (f.goal.phase === 'LAUNCH') expect(n).toMatchObject({ bidCents: null, none: "LAUNCH: the goal's own aim decides" })
      else {
        expect(n.bidCents).not.toBeNull()
        expect(n.words).toMatch(/^profit-best \d+¢ beside the goal's \d+¢ \(in band \d+¢.*; ε 0\.8 ± 0\.4, prior; marginal ACoS [\d.]+% at \d+¢, [\d.]+% at \d+¢(, break-even 35%)?\)$/)
      }
    }
  })

  it('a thin keyword is held at its parent\'s profit-best bid, as the goal holds it', () => {
    const f = spread()[3]
    const n = responseFor(f, decide(f), { ...prior, mean: 2.9, sd: 0.1, measured: true }, null)!
    const ctx = goalContext(f)!
    const parentBest = profitBestBid({ cr: ctx.est.parent!.cr, aovCents: ctx.est.parent!.aovCents!, ratio: ctx.ratio, breakEven: 0.35, goal: ctx.goal, eps: 2.9, currentCents: f.currentCents, capped: false })
    expect(n.bidCents).toBeLessThanOrEqual(goalTail(ctx, f, parentBest.cents!, null))
  })

  it('a capped campaign says so, and its profit-best never rises above today\'s bid — the band bottom still binds', () => {
    const capped = { tosShare: null, tosDays: 0, cappedDays: 5 }
    const f = spread()[5]
    const free = responseFor(f, decide(f), { ...prior, mean: 2.9 }, null)!
    expect(free.bestCents).toBeGreaterThan(f.currentCents)
    const n = responseFor(f, decide(f), { ...prior, mean: 2.9 }, capped)!
    expect(n.capped).toBe(true)
    expect(n.bestCents).toBe(f.currentCents)
    expect(n.words).toMatch(/held to budget capped: a raise buys no clicks; ε 2\.9 ± 0\.4, prior; budget capped;/)
    // Today's bid under the band bottom: the Owner's band wins (the goal raises it too).
    const low = spread()[2]
    expect(responseFor(low, decide(low), { ...prior, mean: 2.9 }, capped)!.words).toMatch(/held to the band bottom 18%/)
  })

  it('a decision an override makes gets no note', () => {
    const f = { ...spread()[4], overrides: { stop: { bidCents: 2, by: 'suppress-campaign' } } }
    expect(responseFor(f, decide(f), prior, null)).toBeNull()
  })

  it('the summary counts higher, lower, same and none', () => {
    const notes = spread().map((f) => responseFor(f, decide(f), prior, null)).filter((n): n is NonNullable<typeof n> => !!n)
    const s = summarizeResponse(notes, 2)
    expect(s.compared).toBe(notes.length)
    expect(s.higher + s.lower + s.same + s.none).toBe(notes.length)
    expect(s.none).toBe(1)
    expect(s.moves).toBe(2)
  })
})

describe('moveEventsOf', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 86_400_000).toISOString().slice(0, 10)
  const clicks = new Map<string, Map<string, number>>()
  const set = (id: string, from: number, to: number, perDay: number) => {
    const m = clicks.get(id) ?? new Map<string, number>()
    for (let k = from; k <= to; k++) m.set(day(k), perDay)
    clicks.set(id, m)
  }
  set('a', 0, 40, 10)
  set('a', 21, 40, 13)
  set('b', 0, 40, 20)
  set('c', 0, 40, 30)
  const groups = new Map([['g1', ['a', 'b', 'c']]])
  const window = { since: day(0), until: day(40) }

  it('matches up to 7 days each side, leaves the move day out, and builds the control from siblings that did not move', () => {
    const moved = new Map([['a', new Set([day(20)])], ['c', new Set([day(18)])]])
    const [e] = moveEventsOf([{ targetId: 'a', adGroupId: 'g1', day: day(20), fromCents: 20, toCents: 25, prevDay: null, nextDay: null }], clicks, moved, groups, () => 'jacket', window)
    expect(e).toMatchObject({ targetId: 'a', productKey: 'jacket', days: 7, clicksBefore: 70, clicksAfter: 91, control: { before: 140, after: 140 } })
  })

  it('the gap to the keyword\'s previous or next move, and the window\'s ends, shorten the matched days; under 3 is no event', () => {
    const moved = new Map<string, Set<string>>()
    const near = moveEventsOf([{ targetId: 'a', adGroupId: 'g1', day: day(20), fromCents: 20, toCents: 25, prevDay: day(15), nextDay: null }], clicks, moved, groups, () => null, window)
    expect(near[0].days).toBe(4)
    expect(moveEventsOf([{ targetId: 'a', adGroupId: 'g1', day: day(20), fromCents: 20, toCents: 25, prevDay: day(17), nextDay: null }], clicks, moved, groups, () => null, window)).toEqual([])
    expect(moveEventsOf([{ targetId: 'a', adGroupId: 'g1', day: day(38), fromCents: 20, toCents: 25, prevDay: null, nextDay: null }], clicks, moved, groups, () => null, window)).toEqual([])
  })
})
