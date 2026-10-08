/**
 * ONE BRAIN AB-20 — the proof's maths on made-up pairs (brain/proof.ts): weeks, difference-in-differences with its t interval
 * (Welch), the other designs, ratios with a seeded bootstrap, pooling, verdicts, the thin-data path and matching; and the
 * report's one line (brain/proof-read.ts proofLine). Values are made up, round and in cents.
 */
import { describe, expect, it } from 'vitest'
import {
  additiveEstimate, addDays, adProfitOf, designResult, matchControls, MIN_ORDERS, pairWeeks, poolAdditive, ratioEstimate, sampleVariance, tQuantile975, verdictOf, weeksOf,
  welchDf, type DayRow, type MatchFacts, type PairWeeks, type WeekSum,
} from './proof.js'
import { proofLine, type ProductProof } from './proof-read.js'

const day = (d: string, spendCents: number, salesCents: number, orders: number, revenueCents: number | null = null): DayRow => ({ day: d, spendCents, salesCents, orders, revenueCents })
/** `days` days from `from`, each the same. */
const flat = (from: string, days: number, spend: number, sales: number, orders: number, revenue: number | null = null) => Array.from({ length: days }, (_, i) => day(addDays(from, i), spend, sales, orders, revenue))
const week = (salesCents: number, spendCents = 0, orders = 10, revenueCents: number | null = null): WeekSum => ({ salesCents, spendCents, orders, revenueCents })

describe('AB-20 proof — days and weeks', () => {
  it('7-day blocks from the start; a day with no row counts zero; total sales null only when unknown', () => {
    const rows = [day('2026-09-01', 100, 400, 1, 1000), day('2026-09-03', 100, 0, 0, 500), day('2026-09-08', 50, 200, 1, 0)]
    expect(weeksOf(rows, '2026-09-01', 2, true)).toEqual([
      { spendCents: 200, salesCents: 400, orders: 1, revenueCents: 1500 },
      { spendCents: 50, salesCents: 200, orders: 1, revenueCents: 0 },
    ])
    expect(weeksOf(rows, '2026-09-01', 1, false)[0].revenueCents).toBeNull()
    expect(adProfitOf(week(1000, 300), 0.4)).toBe(100)
    expect(adProfitOf(week(1000, 300), null)).toBeNull()
  })

  it('Student\'s t at 97.5 %: the table, between whole numbers, and the expansion beyond 30', () => {
    expect(tQuantile975(1)).toBe(12.706)
    expect(tQuantile975(10)).toBe(2.228)
    expect(tQuantile975(5.4)).toBeCloseTo(2.5214, 4)
    expect(tQuantile975(100)).toBeCloseTo(1.984, 3)
    expect(tQuantile975(10_000)).toBeCloseTo(1.96, 2)
    expect(tQuantile975(0.3)).toBe(12.706)
  })
})

describe('AB-20 proof — difference-in-differences on a made-up pair', () => {
  // Margin 1 and no spend: a week's ad profit is its ad sales, so the arithmetic below is by hand.
  const pw: PairWeeks = {
    design: 'did', weeks: 4,
    after: { brain: [week(10), week(12), week(14), week(12)], control: [week(5), week(5), week(5), week(5)] },
    before: { brain: [week(8), week(8), week(8), week(8)], control: [week(4), week(6), week(4), week(6)] },
    window: { since: ['2026-09-01', '2026-09-28'], before: ['2026-08-04', '2026-08-31'] },
  }
  const profit = (w: WeekSum) => adProfitOf(w, 1)

  it('(brain after − brain before) − (comparison after − comparison before), its t interval with Welch\'s degrees of freedom', () => {
    // After: differences 5, 7, 9, 7 (mean 7, variance 8/3); before: 4, 2, 4, 2 (mean 3, variance 4/3).
    expect(sampleVariance([5, 7, 9, 7])).toBeCloseTo(8 / 3, 10)
    const e = additiveEstimate(pw, profit)
    expect(e.estimate).toBe(4)
    expect(e.variance).toBeCloseTo(1, 10) // 8/3 ÷ 4 + 4/3 ÷ 4
    expect(e.df).toBeCloseTo(5.4, 10)
    expect(welchDf(2 / 3, 4, 1 / 3, 4)).toBeCloseTo(5.4, 10)
    expect(e.low).toBeCloseTo(4 - 2.5214, 4)
    expect(e.high).toBeCloseTo(4 + 2.5214, 4)
    expect(verdictOf('adProfit', e)).toBe('better')
  })

  it('before and after alone (no comparison), and a matched level (no weeks before)', () => {
    const prePost = additiveEstimate({ ...pw, design: 'pre-post', after: { brain: pw.after.brain, control: null }, before: { brain: pw.before!.brain, control: null } }, profit)
    expect(prePost.estimate).toBe(4) // 12 − 8
    const matched = additiveEstimate({ ...pw, design: 'matched', before: null }, profit)
    expect(matched.estimate).toBe(7)
    expect(matched.df).toBe(3)
  })

  it('a side without a margin: ad profit not measured, said so', () => {
    expect(additiveEstimate(pw, (w) => adProfitOf(w, null))).toMatchObject({ estimate: null, method: 'none', note: 'not measured: a side has no margin' })
  })

  it('two pairs pooled: the mean, the variances added, Satterthwaite\'s degrees of freedom', () => {
    const a = additiveEstimate(pw, profit)
    const b = { ...a, estimate: 2, low: null, high: null }
    const pooled = poolAdditive([a, b])
    expect(pooled.estimate).toBe(3)
    expect(pooled.variance).toBeCloseTo(0.5, 10)
    expect(pooled.df).toBeCloseTo(10.8, 6)
    expect(poolAdditive([a])).toBe(a)
  })
})

describe('AB-20 proof — the pair from its days', () => {
  const start = '2026-09-01'
  const newest = addDays(start, 41) // 6 settled weeks
  // Brain: before 7 € a day spend on 40 € sales, after 50 € sales; comparison: 40 € before, 44 € after. Margin 50 %.
  const brain = { productId: 'b', margin: 0.5, revenueKnown: true, rows: [...flat(addDays(start, -42), 42, 1000, 4000, 1, 8000), ...flat(start, 42, 1000, 5000, 2, 10_000)] }
  const control = { productId: 'c', margin: 0.5, revenueKnown: true, rows: [...flat(addDays(start, -42), 42, 1000, 4000, 1, 8000), ...flat(start, 42, 1000, 4400, 1, 8800)] }

  it('six weeks each side: the design, the window and the exact difference of ad profit and of ACoS', () => {
    const pw = pairWeeks({ brain, control, start, newestDay: newest, weeks: 6 })
    if ('notEnough' in pw) throw new Error(pw.notEnough)
    expect(pw.design).toBe('did')
    expect(pw.weeks).toBe(6)
    expect(pw.window).toEqual({ since: ['2026-09-01', '2026-10-12'], before: ['2026-07-21', '2026-08-31'] })
    // A week: brain profit before 7·(2000 − 1000) = 7000, after 7·(2500 − 1000) = 10500; comparison 7000 → 8400.
    const r = designResult([pw], [{ brain: 0.5, control: 0.5 }], 'seed-1')
    expect(r.measures.adProfit.estimate).toBe(2100)
    expect(r.measures.adProfit.low).toBe(2100) // the made-up weeks do not vary: a zero-width interval
    expect(r.measures.orders.estimate).toBe(7) // 14 − 7 − (7 − 7)
    expect(r.measures.acos.estimate).toBeCloseTo((0.2 - 0.25) - (1000 / 4400 - 0.25), 10)
    expect(r.measures.tacos.estimate).toBeCloseTo((0.1 - 0.125) - (1000 / 8800 - 0.125), 10)
    expect(r.enough).toBe(true) // 84 and 42 ad orders each side
    expect(r.measures.adProfit.verdict).toBe('better')
    expect(r.measures.acos.verdict).toBe('better') // lower ACoS is better
  })

  it('fewer than 4 settled weeks since the start: not enough data yet, with the days counted', () => {
    expect(pairWeeks({ brain, control, start, newestDay: addDays(start, 19), weeks: 6 })).toEqual({ notEnough: '20 settled days since the brain started on 2026-09-01; the test needs 28 (4 full weeks)' })
  })

  it('weeks are held to 4–6 and to the settled weeks there are', () => {
    const pw = pairWeeks({ brain, control, start, newestDay: addDays(start, 33), weeks: 6 })
    expect('notEnough' in pw ? 0 : pw.weeks).toBe(4)
    const asked = pairWeeks({ brain, control, start, newestDay: newest, weeks: 2 })
    expect('notEnough' in asked ? 0 : asked.weeks).toBe(4)
  })

  it('no comparison: before and after; no ads before: a matched level; neither: not enough data yet', () => {
    const prePost = pairWeeks({ brain, control: null, start, newestDay: newest, weeks: 6 })
    expect('notEnough' in prePost ? null : prePost.design).toBe('pre-post')
    const fresh = { ...brain, rows: flat(start, 42, 1000, 5000, 2) }
    const matched = pairWeeks({ brain: fresh, control, start, newestDay: newest, weeks: 6 })
    expect('notEnough' in matched ? null : matched.design).toBe('matched')
    expect(pairWeeks({ brain: fresh, control: null, start, newestDay: newest, weeks: 6 })).toEqual({ notEnough: 'no ad weeks before the brain started on 2026-09-01 and no comparable product to set against it' })
  })
})

describe('AB-20 proof — ratios with a seeded bootstrap', () => {
  const noisy = (base: number, swing: number) => [base + swing, base - swing, base + 2 * swing, base, base - swing, base + swing].map((s) => week(s, 1000, 10, s * 2))
  const pw: PairWeeks = {
    design: 'did', weeks: 6,
    after: { brain: noisy(5000, 400), control: noisy(4400, 300) },
    before: { brain: noisy(4000, 300), control: noisy(4000, 200) },
    window: { since: ['2026-09-01', '2026-10-12'], before: ['2026-07-21', '2026-08-31'] },
  }

  it('the same seed draws the same interval; the interval holds the estimate', () => {
    const a = ratioEstimate([pw], 'acos', 'seed-x')
    const b = ratioEstimate([pw], 'acos', 'seed-x')
    expect(a).toEqual(b)
    expect(a.method).toBe('bootstrap')
    expect(a.low!).toBeLessThanOrEqual(a.estimate!)
    expect(a.high!).toBeGreaterThanOrEqual(a.estimate!)
    expect(ratioEstimate([pw], 'acos', 'seed-y').low).not.toBe(a.low)
  })

  it('a period without ad sales cannot be measured; without total sales TACoS is said so', () => {
    const dry = { ...pw, after: { brain: pw.after.brain.map((w) => ({ ...w, salesCents: 0 })), control: pw.after.control } }
    expect(ratioEstimate([dry], 'acos', 's')).toMatchObject({ estimate: null, note: 'not measured: a side has no ad sales in a period' })
    const unknown = { ...pw, before: { brain: pw.before!.brain.map((w) => ({ ...w, revenueCents: null })), control: pw.before!.control } }
    expect(ratioEstimate([unknown], 'tacos', 's').note).toContain('no total sales')
  })

  it('verdicts: an interval wholly on one side of zero, in the brain\'s favour or not', () => {
    expect(verdictOf('acos', { estimate: -0.03, low: -0.05, high: -0.01, method: 'bootstrap' })).toBe('better')
    expect(verdictOf('acos', { estimate: 0.03, low: 0.01, high: 0.05, method: 'bootstrap' })).toBe('worse')
    expect(verdictOf('adProfit', { estimate: 100, low: -20, high: 220, method: 't' })).toBe('no difference shown')
    expect(verdictOf('orders', { estimate: null, low: null, high: null, method: 'none' })).toBeNull()
  })
})

describe('AB-20 proof — thin data (a low-volume product)', () => {
  it('a few orders a week: the numbers are computed, no verdict, and what is missing is said', () => {
    const thin = (orders: number) => Array.from({ length: 6 }, (_, i) => week(8000 + i * 100, 2500, orders))
    const pw: PairWeeks = {
      design: 'did', weeks: 6, after: { brain: thin(1), control: thin(2) }, before: { brain: thin(1), control: thin(3) },
      window: { since: ['2026-09-01', '2026-10-12'], before: ['2026-07-21', '2026-08-31'] },
    }
    const r = designResult([pw], [{ brain: 0.4, control: 0.4 }], 'thin')
    expect(r.enough).toBe(false)
    expect(r.orders).toEqual({ brainSince: 6, brainBefore: 6, comparisonSince: 12, comparisonBefore: 18 })
    expect(r.missing).toEqual([
      `6 ad orders on the brain's side since it started (${MIN_ORDERS} needed)`,
      `6 ad orders on the brain's side in the weeks before (${MIN_ORDERS} needed)`,
      `12 ad orders on the comparison's side since the brain started (${MIN_ORDERS} needed)`,
      `18 ad orders on the comparison's side in the weeks before (${MIN_ORDERS} needed)`,
    ])
    expect(Object.values(r.measures).map((m) => m.verdict)).toEqual([null, null, null, null])
    expect(r.measures.adProfit.estimate).toBe(0)
  })
})

describe('AB-20 proof — matching', () => {
  const facts = (productId: string, over: Partial<MatchFacts>): MatchFacts => ({ productId, name: productId, categoryId: 'cat-a', priceCents: 8000, spendBeforeCents: 10_000, spendSinceCents: 10_000, orders: 10, ...over })

  it('same category, price within ×1.5, spend within ×2, ads running since — the nearest, each used once', () => {
    const brains = [facts('b1', {}), facts('b2', {})]
    const candidates = [
      facts('x', { priceCents: 9000, spendBeforeCents: 12_000 }),
      facts('v', { priceCents: 8000, spendBeforeCents: 9_000 }),
      facts('y', { categoryId: 'cat-b' }),
      facts('z', { priceCents: 13_000 }),
      facts('w', { spendBeforeCents: 30_000 }),
      facts('q', { spendSinceCents: 0 }),
    ]
    const m = matchControls(brains, candidates)
    expect(m.get('b1')?.control?.productId).toBe('v')
    expect(m.get('b2')?.control?.productId).toBe('x')
    expect(m.get('b1')?.why).toBe('the nearest of 2 products without the brain that fit (same market, same category, price within ×1.5, ad spend before within ×2, ads running since)')
  })

  it('nothing fits: no comparison, said with the criteria; a criterion the brain product has no data for is not applied', () => {
    expect(matchControls([facts('b', {})], [facts('y', { categoryId: 'cat-b' })]).get('b')).toMatchObject({ control: null, why: 'no product without the brain fits (same market, same category, price within ×1.5, ad spend before within ×2, ads running since)' })
    const loose = matchControls([facts('b', { categoryId: null, spendBeforeCents: 0 })], [facts('y', { categoryId: 'cat-b', spendBeforeCents: 50_000 })]).get('b')
    expect(loose?.control?.productId).toBe('y')
    expect(loose?.why).toContain('the brain product has no category: any category; no ad spend before the brain started: any spend level')
  })
})

describe('AB-20 proof — the report\'s line', () => {
  const base: ProductProof = {
    productId: 'p', name: 'Test jacket', start: { day: '2026-09-01', how: 'the bid brain took campaign c1 live' }, status: 'NOT_ENOUGH_DATA', notEnough: [],
    comparison: null, matchWhy: null, margin: { source: 'true-profit', words: 'x' }, comparisonMargin: null, result: null, window: null,
  }

  it('nothing to compare, not enough data yet, measured — no amounts in any', () => {
    expect(proofLine({ ...base, status: 'NO_BRAIN_PRODUCT', start: null, notEnough: ['the brain writes nothing on this product yet (every lever in shadow): nothing to compare'] }))
      .toBe('Proof (A/B, ad profit): nothing to compare yet — the brain writes nothing on this product yet (every lever in shadow): nothing to compare.')
    expect(proofLine({ ...base, notEnough: ['12 of 28 settled days since the brain started on 2026-09-01 (4 full weeks needed)'] }))
      .toBe('Proof (A/B, ad profit): not enough data yet — 12 of 28 settled days since the brain started on 2026-09-01 (4 full weeks needed).')
    const pw: PairWeeks = {
      design: 'did', weeks: 4, after: { brain: [week(10, 0, 20), week(12, 0, 20), week(14, 0, 20), week(12, 0, 20)], control: [week(5, 0, 20), week(5, 0, 20), week(5, 0, 20), week(5, 0, 20)] },
      before: { brain: Array(4).fill(week(8, 0, 20)), control: [week(4, 0, 20), week(6, 0, 20), week(4, 0, 20), week(6, 0, 20)] }, window: { since: ['2026-09-01', '2026-09-28'], before: ['2026-08-04', '2026-08-31'] },
    }
    const result = designResult([pw], [{ brain: 1, control: 1 }], 's')
    const line = proofLine({ ...base, status: 'MEASURED', comparison: { productId: 'q', name: 'Other jacket', why: 'x' }, result })
    expect(line).toBe('Proof (A/B, ad profit, difference-in-differences, 4 weeks against Other jacket): ad profit better with the brain; ACoS no difference shown yet; TACoS not measured: a side has no total sales (or none known) in a period; ad orders no difference shown yet (95 % intervals).')
    expect(line).not.toMatch(/€|\d+\.\d{2}/)
  })
})
