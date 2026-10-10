/**
 * ONE BRAIN AB-13 — the hour research maths (brain/hours-research.ts), on made-up hourly data (public repo: invented,
 * round numbers; the days are real calendar days so weekdays are right — 2026-09-07 is a Monday).
 *
 *   shrinkage    an index with no evidence is its parent's; with much evidence it is its own; a cost-per-click index and
 *                a traffic share the same way; normalised to a click-weighted mean of 1
 *   aggregation  hour-of-week, 4-hour block, day part and weekday sums from local days and hours
 *   pooling      a thin product's curve comes from its pool (category, then market); a dense one keeps its own; how much
 *                each pool carries is said, and sums to 1
 *   confidence   thin below 10 orders a 30 days, solid from 30
 *   dynamics     weekend against weekdays, the recent trend, the market's day, the lanes, and the summary in words
 */
import { describe, expect, it } from 'vitest'
import {
  blockKey, hourKey, intervalFactors, normalise, poolCurves, researchHours, shrinkCpcIndex, shrinkIndex, shrinkShares, weekdayOf,
  topOfSearchShareWords, PRIOR_ORDERS, type ResearchFacts,
} from './hours-research.js'
import { cellsOf, daysFrom, factsOf, totalsOf } from './__fixtures__/hours-facts.js'

const FOUR_WEEKS = daysFrom('2026-09-07', 28) // Monday 7 September … Sunday 4 October
const evening = (h: number) => h >= 16 && h < 20
const night = (h: number) => h < 4

describe('shrinkage', () => {
  it('a conversion index: no evidence → its parent; much evidence → its own; the pool counts as three orders', () => {
    expect(shrinkIndex(0, 0, 1.4)).toBeCloseTo(1.4, 10)
    expect(shrinkIndex(0, 0, 0)).toBe(1) // no parent: flat
    expect(shrinkIndex(200, 100, 1)).toBeCloseTo(203 / 103, 10) // ≈ 2, its own
    expect(shrinkIndex(0, 6, 1)).toBeCloseTo(PRIOR_ORDERS / (6 + PRIOR_ORDERS), 10) // six expected orders, none came: a third
  })

  it('a cost-per-click index and a traffic share are pulled toward their parent with clicks of weight', () => {
    expect(shrinkCpcIndex(0, 0, 40, 1.2)).toBeCloseTo(1.2, 10)
    expect(shrinkCpcIndex(60_000, 1000, 40, 1)).toBeCloseTo((60_000 + 20 * 40) / (1020 * 40), 10) // ≈ 1.5
    const shares = shrinkShares([100, 0, 0, 0], null)
    expect(shares.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10)
    expect(shares[0]).toBeGreaterThan(0.6)
    expect(shares[1]).toBeGreaterThan(0)
    expect(normalise([2, 1, 0.5], [1, 1, 2]).reduce((s, x, i) => s + x * [1, 1, 2][i], 0) / 4).toBeCloseTo(1, 10)
  })

  it('the 80 % interval narrows as evidence grows', () => {
    const wide = intervalFactors([3, 3]), narrow = intervalFactors([300, 300])
    expect(wide.hi).toBeGreaterThan(2.5)
    expect(narrow.hi).toBeLessThan(1.15)
    expect(wide.lo * wide.hi).toBeCloseTo(1, 10)
  })
})

describe('aggregation by hour of the week', () => {
  it('local days and hours sum into their hour of the week, block, day part and weekday', () => {
    expect(weekdayOf('2026-09-07')).toBe(1) // Monday
    expect(weekdayOf('2026-09-13')).toBe(0) // Sunday
    const days = daysFrom('2026-09-07', 14)
    // 4 clicks an hour, Mondays 16–19 only, one order in eight clicks.
    const cells = cellsOf(days, { clicks: (d, h) => (d === 1 && evening(h) ? 4 : 0), cr: () => 0.125 })
    const c = poolCurves(cells, null)
    expect(c.total).toMatchObject({ clicks: 32, orders: 4 })
    expect(c.hourOfWeek.own[hourKey(1, 16)].clicks).toBe(8)
    expect(c.hourOfWeek.own[hourKey(2, 16)].clicks).toBe(0)
    expect(c.block.own[blockKey(1, 4)]).toMatchObject({ clicks: 32, orders: 4 })
    expect(c.part.own[4].clicks).toBe(32)
    expect(c.weekday.own[1].clicks).toBe(32)
    // Shares sum to 1; the traffic sits where the clicks are.
    expect(c.block.share.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10)
    expect(c.block.share[blockKey(1, 4)]).toBeGreaterThan(0.3)
  })
})

/** A market whose evenings convert 3 × and nights 0.2 × (many orders), and a product's own shape. */
const marketShape = {
  clicks: (_d: number, h: number) => (night(h) ? 10 : 40),
  cr: (_d: number, h: number) => (evening(h) ? 0.06 : night(h) ? 0.004 : 0.02),
}

describe('pooling product → category → market', () => {
  it('a thin product (a few orders) takes its hour curve from the market, and says so', () => {
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product: { clicks: () => 2, cr: () => 0.004 }, market: marketShape }))
    expect(r.level.product.orders).toBeLessThan(10)
    expect(r.confidence).toMatchObject({ label: 'low', thin: true })
    const ev = r.blocks[blockKey(3, 4)].crIndex, ni = r.blocks[blockKey(3, 0)].crIndex
    expect(ev).toBeGreaterThan(1.5) // the market's evening
    expect(ni).toBeLessThan(0.5) // the market's night
    expect(r.confidence.leansOn.market).toBeGreaterThan(r.confidence.leansOn.product)
    const s = r.confidence.leansOn
    expect(s.product + s.category + s.market + s.flat).toBeCloseTo(1, 1)
    expect(r.confidence.words).toMatch(/Low confidence: .* thin\); the hour curve leans on the product's own data \d+ %, the market \d+ %/)
  })

  it('a dense product keeps its own curve against the market\'s (its mornings, not the market\'s evenings)', () => {
    const product = { clicks: () => 30, cr: (_d: number, h: number) => (h >= 8 && h < 12 ? 0.08 : 0.01) }
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product, market: marketShape }))
    expect(r.confidence.label).toBe('high')
    expect(r.blocks[blockKey(2, 2)].crIndex).toBeGreaterThan(r.blocks[blockKey(2, 4)].crIndex) // 08–12 over 16–20
    expect(r.confidence.leansOn.product).toBeGreaterThan(0.8)
  })

  it('a category sits between the product and the market', () => {
    const category = { clicks: () => 20, cr: (_d: number, h: number) => (h >= 20 ? 0.05 : 0.01) }
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product: { clicks: () => 1, cr: () => 0 }, category, market: marketShape }))
    // The category's late evening beats the market's 16–20 for this product.
    expect(r.blocks[blockKey(4, 5)].crIndex).toBeGreaterThan(r.blocks[blockKey(4, 4)].crIndex)
    expect(r.confidence.leansOn.category).toBeGreaterThan(0)
    expect(r.summary[0]).toMatch(/pooled with 6 campaigns of its category "Test jackets" and 20 campaigns of the market/)
  })

  it('the level: the product\'s conversion and order value shrink to its pool; expected ACoS = CPC ÷ (CR × order value)', () => {
    const daily = { product: { impressions: 0, clicks: 500, spendCents: 20_000, orders: 0, salesCents: 0 }, market: { impressions: 0, clicks: 10_000, spendCents: 400_000, orders: 200, salesCents: 1_600_000 } }
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product: { clicks: () => 1, cr: () => 0 }, market: marketShape, daily }))
    // No order of its own: the market's 2 % with three orders of weight against its 500 clicks.
    expect(r.expected.cr).toBeCloseTo(3 / (500 + 3 / 0.02), 4)
    expect(r.expected.aovCents).toBe(8000)
    expect(r.expected.acos).toBeCloseTo(40 / ((3 / (500 + 3 / 0.02)) * 8000), 3)
    expect(r.expected.week.spendCents).toBe(5000) // four weeks of 200.00
  })
})

describe('batch 2 fix — capped grain days', () => {
  const dense = { clicks: () => 30, cr: (_d: number, h: number) => (h >= 8 && h < 12 ? 0.08 : 0.01) }
  it('capped days read from the campaign grain: said in the confidence words, the label kept', () => {
    const f = factsOf({ days: FOUR_WEEKS, product: dense, market: marketShape })
    const r = researchHours({ ...f, sources: { ...f.sources, cappedDays: ['2026-09-20'], cappedGrainHours: 12, cappedUnfilledHours: 0 } })
    expect(r.confidence.label).toBe('high')
    expect(r.confidence.words).toMatch(/1 day of the window \(2026-09-20, UTC\) the ad group grain was incomplete \(its ingest refused records at its ceiling\): every hour of it is read from the campaign grain\.$/)
    expect(r.sources).toMatchObject({ cappedDays: ['2026-09-20'], cappedGrainHours: 12, cappedUnfilledHours: 0 })
  })

  it('capped hours neither source holds: one step less sure (high → medium, medium → low), and said', () => {
    const f = factsOf({ days: FOUR_WEEKS, product: dense, market: marketShape })
    const r = researchHours({ ...f, sources: { ...f.sources, cappedDays: ['2026-09-20', '2026-09-21'], cappedGrainHours: 30, cappedUnfilledHours: 6 } })
    expect(r.confidence.label).toBe('medium')
    expect(r.confidence.words).toMatch(/^Medium confidence: .*2 days of the window \(2026-09-20, 2026-09-21, UTC\) .* and 6 hours the grain held are in neither source — one step less sure\.$/)
    const medium = factsOf({ days: FOUR_WEEKS, product: { clicks: () => 1, cr: () => 0.03 }, market: marketShape })
    expect(researchHours(medium).confidence.label).toBe('medium')
    expect(researchHours({ ...medium, sources: { ...medium.sources, cappedDays: ['2026-09-20'], cappedUnfilledHours: 1 } }).confidence.label).toBe('low')
    // Nothing capped: as before.
    expect(researchHours(f).confidence.words).not.toMatch(/incomplete/)
  })
})

describe('the market\'s dynamics', () => {
  it('weekend against weekdays: clicks a day and conversion', () => {
    const product = { clicks: (d: number) => (d === 0 || d === 6 ? 20 : 10), cr: (d: number) => (d === 0 || d === 6 ? 0.01 : 0.02) }
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product, market: product }))
    expect(r.weekend.clicksPerDay).toBeGreaterThan(1.8)
    expect(r.weekend.cr).toBeLessThan(0.7)
    expect(r.summary.join('\n')).toMatch(/Weekend against weekdays: clicks a day \+\d+ %, cost per click [+−]\d+ %, conversion −\d+ % \(pooled\)/)
  })

  it('the trend: the last 14 days against the 14 before; conversion only with enough orders', () => {
    const late = new Set(FOUR_WEEKS.slice(14))
    const product = { clicks: (_d: number, _h: number, day: string) => (late.has(day) ? 4 : 2), cr: () => 0.0005 }
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product, market: marketShape }))
    expect(r.trend.span).toBe('the last 14 days against the 14 before')
    expect(r.trend.clicks).toBeCloseTo(2, 5)
    expect(r.trend.cr).toBeNull()
    expect(r.summary.join('\n')).toMatch(/too few orders to tell conversion/)
  })

  it('the market\'s day in words: its peak, its quietest part, cost per click and when it converts', () => {
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product: { clicks: () => 2, cr: () => 0.01 }, market: marketShape }))
    expect(r.marketDay).toMatchObject({ crCurveSeen: true, crBestPart: 4, crWorstPart: 0, quietParts: [0] })
    expect(r.summary.join('\n')).toMatch(/The market's day: its clicks hold steady over 5 of the day's six parts, quietest 00–04 \(\d+ %\); a click costs about the same all day/)
    expect(r.summary.join('\n')).toMatch(/Market conversion is best 16–20 \([\d.]+ × the average\) and worst 00–04/)
  })

  it('lanes: top of search\'s share, its conversion against the rest, Amazon\'s impression share', () => {
    const lanes: ResearchFacts['lanes'] = [
      { lane: 'TOP_OF_SEARCH', impressions: 1000, clicks: 300, spendCents: 15_000, orders: 9, salesCents: 72_000, topOfSearchSharePct: 12, topOfSearchShareBasis: { campaigns: 3, days: 21, newest: '2026-10-08' } },
      { lane: 'REST_OF_SEARCH', impressions: 4000, clicks: 600, spendCents: 18_000, orders: 6, salesCents: 48_000, topOfSearchSharePct: null },
      { lane: 'PRODUCT_PAGE', impressions: 3000, clicks: 100, spendCents: 2_000, orders: 0, salesCents: 0, topOfSearchSharePct: null },
    ]
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product: { clicks: () => 2, cr: () => 0.01 }, market: marketShape, lanes }))
    expect(r.topOfSearchShareKnown).toBe(true)
    expect(r.topOfSearchSpendShare).toBeCloseTo(15_000 / 35_000, 4)
    // C2 (2026-10-10) — Amazon's per campaign and day; the average is Nexus's, over named campaigns and days, dated
    expect(r.summary.join('\n')).toMatch(/top of search 30 % of clicks and 43 % of spend, converting 3.5 × the other lanes; the top-of-search impression share Amazon reported for these 3 campaigns \(campaign level\), averaged by Nexus over 21 days with a reading, newest 2026-10-08: about 12 %/)
    expect(r.summary.join('\n')).not.toMatch(/Amazon's top-of-search impression share about/)
    expect(r.lanes.find((l) => l.lane === 'TOP_OF_SEARCH')!.topOfSearchShareBasis).toEqual({ campaigns: 3, days: 21, newest: '2026-10-08' })
  })

  it('C2 — the words: one campaign and one day read as such; a tiny real share is never "about 0 %"', () => {
    expect(topOfSearchShareWords(34.4, { campaigns: 1, days: 1, newest: '2026-10-08' }))
      .toBe('the top-of-search impression share Amazon reported for this campaign (campaign level), averaged by Nexus over 1 day with a reading, newest 2026-10-08: about 34 %')
    expect(topOfSearchShareWords(0.004, { campaigns: 2, days: 5, newest: null })).toMatch(/: about <0\.01 %$/)
    expect(topOfSearchShareWords(0.4, null)).toBe('the top-of-search impression share Amazon reported for these campaigns (campaign level), averaged by Nexus: about 0.40 %')
  })

  it('no Marketing Stream hours: said, and nothing invented', () => {
    const r = researchHours({ ...factsOf({ days: FOUR_WEEKS, product: { clicks: () => 0, cr: () => 0 }, market: { clicks: () => 0, cr: () => 0 } }) })
    expect(r.summary.join('\n')).toMatch(/No Marketing Stream hours reached Nexus/)
    expect(r.blocks.every((b) => b.crIndex === 1)).toBe(true)
  })
})

describe('an example research summary (made-up data, printed for the report)', () => {
  it('reads as plain words', () => {
    const category = { clicks: (_d: number, h: number) => (night(h) ? 3 : 12), cr: (_d: number, h: number) => (h >= 18 ? 0.03 : 0.012) }
    const product = { clicks: (d: number, h: number) => (night(h) ? 0 : d === 0 || d === 6 ? 2 : 1), cr: (_d: number, h: number) => (h >= 18 ? 0.02 : 0.005) }
    const lanes: ResearchFacts['lanes'] = [
      { lane: 'TOP_OF_SEARCH', impressions: 2000, clicks: 200, spendCents: 9_000, orders: 3, salesCents: 24_000, topOfSearchSharePct: 10 },
      { lane: 'REST_OF_SEARCH', impressions: 6000, clicks: 300, spendCents: 9_000, orders: 2, salesCents: 16_000, topOfSearchSharePct: null },
    ]
    const r = researchHours(factsOf({ days: FOUR_WEEKS, product, category, market: marketShape, lanes }))
    const text = [...r.summary, ...r.money].join('\n')
    // eslint-disable-next-line no-console
    console.log(`\n── example research summary ──\n${text}\n`)
    expect(r.summary.length).toBeGreaterThanOrEqual(7)
    expect(text).not.toMatch(/NaN|undefined|Infinity/)
    expect(totalsOf(r.blocks.map((b) => b.own)).clicks).toBe(r.level.product.clicks)
  })
})
