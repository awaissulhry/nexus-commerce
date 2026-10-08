/**
 * ONE BRAIN AB-13 — made-up hourly data for the hours research and painting tests (public repo: round, invented numbers,
 * generic names). Deterministic: orders come from a carried remainder, never from a random draw.
 */
import type { HourCell, HoursResearch, ResearchFacts, Totals, BlockResearch } from '../hours-research.js'
import { PARTS } from '../hours-research.js'
import type { PaintTarget } from '../hours-paint.js'

const DAY_MS = 86_400_000
/** `n` local days from `from` (YYYY-MM-DD), oldest first. */
export const daysFrom = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10))
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay()

export interface Shape {
  /** Clicks in one hour of one day. */
  clicks: (d: number, h: number, day: string) => number
  /** Cost per click in cents. */
  cpcCents?: (d: number, h: number) => number
  /** Conversion rate (orders per click). */
  cr: (d: number, h: number) => number
  aovCents?: number
}

/** Hourly cells for every day and hour where the shape has clicks; orders carry their remainder (deterministic). */
export function cellsOf(days: readonly string[], shape: Shape): HourCell[] {
  let carry = 0
  const out: HourCell[] = []
  for (const day of days) {
    const d = weekday(day)
    for (let h = 0; h < 24; h++) {
      const clicks = Math.max(0, Math.round(shape.clicks(d, h, day)))
      if (!clicks) continue
      carry += clicks * shape.cr(d, h)
      const orders = Math.floor(carry + 1e-9)
      carry -= orders
      const cpc = shape.cpcCents ? shape.cpcCents(d, h) : 40
      out.push({ day, hour: h, impressions: clicks * 50, clicks, spendCents: clicks * cpc, orders, salesCents: orders * (shape.aovCents ?? 8000) })
    }
  }
  return out
}

export const totalsOf = (cells: readonly Totals[]): Totals => cells.reduce<Totals>((t, c) => ({
  impressions: t.impressions + c.impressions, clicks: t.clicks + c.clicks, spendCents: t.spendCents + c.spendCents, orders: t.orders + c.orders, salesCents: t.salesCents + c.salesCents,
}), { impressions: 0, clicks: 0, spendCents: 0, orders: 0, salesCents: 0 })

/** Research facts from three shapes (the daily level is the hourly cells' own totals unless given). */
export function factsOf(input: { days: string[]; product: Shape; category?: Shape | null; market: Shape; daily?: Partial<ResearchFacts['daily']>; lanes?: ResearchFacts['lanes']; productName?: string }): ResearchFacts {
  const product = cellsOf(input.days, input.product)
  const category = input.category ? cellsOf(input.days, input.category) : null
  const market = cellsOf(input.days, input.market)
  return {
    productId: 'prod-jacket', productName: input.productName ?? 'Test jacket', market: 'IT', timeZone: 'Europe/Rome',
    days: input.days, leftOut: [],
    hours: { product, category, market },
    daily: { product: input.daily?.product ?? totalsOf(product), category: input.daily?.category ?? (category ? totalsOf(category) : null), market: input.daily?.market ?? totalsOf(market) },
    lanes: input.lanes ?? [],
    categoryName: category ? 'Test jackets' : null,
    campaigns: { product: 2, category: category ? 6 : 0, market: 20 },
    sources: { placementGrainHours: 0, campaignGrainHours: product.length, lateStartCells: 0, negativeCells: 0, newestArrivalAt: null },
  }
}

/** A library of five made-up targets: rest (rest of search 0 %), defend (top 50 %), own (top 100 %), allout (top 150 %), pause (Min bid). */
export function testTargets(): Map<string, PaintTarget> {
  const t = (key: string, placementPct: number, lanes: PaintTarget['lanes'], floor = false): PaintTarget => ({ key, name: key, floor, placementPct, lanes, maxCpcCents: null })
  return new Map([
    ['rest', t('rest', 0, { REST_OF_SEARCH: 0 })],
    ['defend', t('defend', 50, { TOP_OF_SEARCH: 50 })],
    ['own', t('own', 100, { TOP_OF_SEARCH: 100 })],
    ['allout', t('allout', 150, { TOP_OF_SEARCH: 150 })],
    ['pause', t('pause', 0, {}, true)],
  ])
}

/**
 * A research object made by hand: the product's expected level (ACoS from cost per click, conversion and order value)
 * and each 4-hour block from `block(d, part)`; every hour shares the week evenly unless the block says otherwise.
 */
export function researchWith(opts: {
  cr?: number; cpcCents?: number; aovCents?: number; levelOrders?: number; weekSpendCents?: number
  block?: (d: number, part: number) => Partial<BlockResearch> & { spendCents?: number; clicks?: number; orders?: number }
  thin?: boolean
}): HoursResearch {
  const cr = opts.cr ?? 0.02, cpc = opts.cpcCents ?? 40, aov = opts.aovCents ?? 8000
  const levelOrders = opts.levelOrders ?? 30
  const weekSpend = opts.weekSpendCents ?? 7000
  const blocks: BlockResearch[] = Array.from({ length: 7 * PARTS }, (_, k) => {
    const d = Math.floor(k / PARTS), part = k % PARTS
    const { spendCents, clicks, orders, ...rest } = opts.block?.(d, part) ?? {}
    const own: Totals = { impressions: 0, clicks: clicks ?? 20, spendCents: spendCents ?? 800, orders: orders ?? 0, salesCents: 0 }
    return { d, part, clicksShare: 1 / 42, pooledClicksShare: 1 / 42, cpcIndex: 1, pooledCpcIndex: 1, crIndex: 1, crShape: 30, ...rest, own }
  })
  const hours = Array.from({ length: 168 }, (_, k) => {
    const d = Math.floor(k / 24), h = k % 24
    const b = blocks[d * PARTS + Math.floor(h / 4)]
    return { d, h, clicks: 5, orders: 0, spendCents: b.own.spendCents / 4, clicksShare: 1 / 168, cpcIndex: b.cpcIndex, crIndex: b.crIndex }
  })
  const level = { impressions: 0, clicks: Math.round(levelOrders / cr), spendCents: Math.round(levelOrders / cr) * cpc, orders: levelOrders, salesCents: levelOrders * aov, cr, cpcCents: cpc, acos: cpc / (cr * aov), aovCents: aov }
  return {
    version: 1, productId: 'prod-jacket', productName: 'Test jacket', market: 'IT', timeZone: 'Europe/Rome',
    window: { from: '2026-09-10', to: '2026-10-07', days: 28, weeks: 4 }, leftOut: [],
    level: { product: level, category: null, market: level },
    expected: { cr, crShape: levelOrders + 3, aovCents: aov, acos: cpc / (cr * aov), cpcCents: cpc, week: { spendCents: weekSpend, clicks: weekSpend / cpc, orders: (weekSpend / cpc) * cr, salesCents: (weekSpend / cpc) * cr * aov } },
    confidence: { label: opts.thin ? 'low' : 'high', thin: !!opts.thin, ordersPer30d: levelOrders, leansOn: { product: 0.8, category: 0, market: 0.2, flat: 0 }, words: opts.thin ? 'Low confidence; the hour curve leans on the market' : 'High confidence' },
    blocks, hours,
    dayParts: [], weekdays: [], weekend: { clicksPerDay: null, cpc: null, cr: null },
    trend: { span: null, clicks: null, cpc: null, cr: null, marketCpc: null },
    marketDay: { campaigns: 20, peakParts: [], quietParts: [], cpcHighPart: null, cpcLowPart: null, crBestPart: null, crWorstPart: null, crCurveSeen: false },
    lanes: [], topOfSearchSpendShare: 0.5, topOfSearchShareKnown: false,
    sources: { placementGrainHours: 0, campaignGrainHours: 0, lateStartCells: 0, negativeCells: 0, newestArrivalAt: null, campaigns: { product: 2, category: 0, market: 20 }, categoryName: null, productFromShared: false },
    summary: [], money: [],
  }
}
