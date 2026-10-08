/**
 * BID BRAIN BB-13 (2026-10-08, design BRAIN-UPGRADES-DESIGN.md U1a) — the report pulls that make every ad day SETTLE, and
 * the read that shows how much a first copy under-counted. The pure day logic lives in `ads-report-settle.ts`.
 *
 *   nightly    `settlingCycle` / `perDaySettlingCycle`: the five daily report crons (ads-sync.job.ts) ask the span where a
 *              day still fills — Sponsored Products the last 8 days, Brands and Display the last 15 — as one ranged job per
 *              account and report; the two reports Amazon answers one day at a time (targeting, advertised product) ask
 *              yesterday and the day that completes tonight. Same number of ranged jobs as before; 2 instead of 1 for
 *              the per-day reports.
 *   catch-up   `runSettleCatchUp`: the days of the last 60 (inside Amazon's retention) that hold no settled copy yet are
 *              asked again, at most `maxJobs` report jobs a run, ranged reports first. After deploy it re-reads the 60
 *              days once — the campaign ingest keeps each day's first copy as a vintage before the re-read replaces it,
 *              which measures the gap — and from then on it finds nothing (the nightly span settles each new day),
 *              unless a night's settling pull failed: then it asks that day again (twice at most, then the day is given
 *              up and named in the log). Idempotent: a day with a settling pull ingested or in flight is never asked.
 *   read       `dataVintageByMarket`: per market, the newest settled day and, over the days that have both, the sales and
 *              orders of the first copy against the settled copy (ads-overview → dataVintage).
 *
 * Every report goes through the existing report pipeline (createReportJob → liveCall → the channel gateway).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  contiguousRuns,
  daysBefore,
  isoDay,
  perDaySettleDays,
  settleRange,
  settleSpanDays,
  settledThrough,
  unsettledDays,
  utcDay,
  type PullJob,
} from './ads-report-settle.js'
import {
  ADVERTISED_PRODUCT_REPORT_TYPE_ID,
  CAMPAIGN_REPORT_TYPE_ID,
  PLACEMENT_REPORT_TYPE_ID,
  SEARCH_TERM_REPORT_TYPE_ID,
  TARGETING_REPORT_TYPE_ID,
  deliveringAdProducts,
  runAdvertisedProductReportCycle,
  runPlacementReportCycle,
  runReportCreationCycle,
  runSearchTermReportCycle,
  runTargetingReportCycle,
  type AdProduct,
  type CreationCycleResult,
} from './ads-reports.service.js'

const DAY = 86_400_000

type RangeArgs = { startDate: string; endDate: string; adProducts?: AdProduct[]; profileIds?: readonly string[] }
type Cycle = (args: RangeArgs) => Promise<CreationCycleResult>

const empty = (): CreationCycleResult => ({ jobsCreated: 0, jobsSkipped: 0, errors: [] })
function add(into: CreationCycleResult, r: CreationCycleResult): CreationCycleResult {
  into.jobsCreated += r.jobsCreated
  into.jobsSkipped += r.jobsSkipped
  into.errors.push(...r.errors)
  return into
}

// ── Nightly ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * One ranged report cycle over each ad product's settling span (`settleRange`): ad products with the same span share one
 * call, so Sponsored Products asks [today − 8, yesterday] and Brands + Display ask [today − 15, yesterday].
 */
export async function settlingCycle(cycle: Cycle, adProducts: readonly AdProduct[], now: Date = new Date()): Promise<CreationCycleResult> {
  const bySpan = new Map<number, AdProduct[]>()
  for (const p of adProducts) {
    const span = settleSpanDays(p)
    bySpan.set(span, [...(bySpan.get(span) ?? []), p])
  }
  const out = empty()
  for (const products of bySpan.values()) {
    add(out, await cycle({ ...settleRange(products[0], now), adProducts: products }))
  }
  return out
}

/** A per-day report (targeting, advertised product; Sponsored Products only): yesterday and the day that completes tonight. */
export async function perDaySettlingCycle(cycle: Cycle, now: Date = new Date()): Promise<CreationCycleResult> {
  const out = empty()
  for (const day of perDaySettleDays('SPONSORED_PRODUCTS', now)) add(out, await cycle({ startDate: day, endDate: day }))
  return out
}

// ── Catch-up ─────────────────────────────────────────────────────────────────────────────────────────

/** Days back the catch-up reaches (the design's one-time re-read of 60 days). */
export const CATCH_UP_DAYS = 60
/** Amazon keeps report data this many days per ad product; a day is never asked closer than one day to that edge. */
const RETENTION_DAYS: Record<string, number> = { SPONSORED_PRODUCTS: 95, SPONSORED_BRANDS: 60, SPONSORED_DISPLAY: 65 }
/** Report jobs one catch-up run may create (it runs several times a night: ads-sync.job.ts). */
export const CATCH_UP_MAX_JOBS = 30
/** Amazon refuses a report range over 31 days. */
const MAX_RANGE_DAYS = 30

interface ReportKind {
  label: string
  reportTypeId: string
  adProduct: AdProduct
  /** True: one job asks a range. False: Amazon answers one day per job. */
  ranged: boolean
  cycle: Cycle
}

const campaignKind = (adProduct: AdProduct): ReportKind => ({
  label: `campaign ${adProduct}`, reportTypeId: CAMPAIGN_REPORT_TYPE_ID[adProduct], adProduct, ranged: true,
  cycle: (a) => runReportCreationCycle({ ...a, adProducts: [adProduct] }),
})
const searchTermKind = (adProduct: AdProduct): ReportKind => ({
  label: `search-term ${adProduct}`, reportTypeId: SEARCH_TERM_REPORT_TYPE_ID[adProduct]!, adProduct, ranged: true,
  cycle: (a) => runSearchTermReportCycle({ ...a, adProducts: [adProduct] }),
})

/** Ranged reports first (they settle 30 days a job), the per-day reports after. */
export const SETTLE_KINDS: readonly ReportKind[] = [
  campaignKind('SPONSORED_PRODUCTS'),
  campaignKind('SPONSORED_BRANDS'),
  campaignKind('SPONSORED_DISPLAY'),
  searchTermKind('SPONSORED_PRODUCTS'),
  searchTermKind('SPONSORED_BRANDS'),
  { label: 'placement', reportTypeId: PLACEMENT_REPORT_TYPE_ID, adProduct: 'SPONSORED_PRODUCTS', ranged: true, cycle: (a) => runPlacementReportCycle(a) },
  { label: 'targeting', reportTypeId: TARGETING_REPORT_TYPE_ID, adProduct: 'SPONSORED_PRODUCTS', ranged: false, cycle: (a) => runTargetingReportCycle(a) },
  { label: 'advertised product', reportTypeId: ADVERTISED_PRODUCT_REPORT_TYPE_ID, adProduct: 'SPONSORED_PRODUCTS', ranged: false, cycle: (a) => runAdvertisedProductReportCycle(a) },
]

/** The oldest and newest day the catch-up looks at for one ad product: [today − min(60, retention − 1), today − span]. */
export function catchUpBounds(adProduct: string, now: Date): { from: Date; to: Date } {
  const back = Math.min(CATCH_UP_DAYS, (RETENTION_DAYS[adProduct] ?? 60) - 1)
  return { from: daysBefore(now, back), to: daysBefore(now, settleSpanDays(adProduct)) }
}

export interface CatchUpResult extends CreationCycleResult {
  /** `${market}/${report}: n days` still waiting after this run (asked next run). */
  waiting: string[]
  /** `${market}/${report}: day` whose settling pulls failed twice: no longer asked. */
  givenUp: string[]
  /** True when the run stopped at `maxJobs`. */
  capped: boolean
}

/**
 * Asks again every day of the catch-up window that holds no settled copy yet, per account and report, until `maxJobs`
 * report jobs were created. Accounts and ad products the report cycles would skip anyway (no campaigns, dormant) are
 * not asked. A report kind that errors for an account stops for that account this run (no hammering).
 */
export async function runSettleCatchUp(opts: { now?: Date; maxJobs?: number } = {}): Promise<CatchUpResult> {
  const now = opts.now ?? new Date()
  const maxJobs = opts.maxJobs ?? CATCH_UP_MAX_JOBS
  const out: CatchUpResult = { ...empty(), waiting: [], givenUp: [], capped: false }

  const connections = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, marketplace: true } })
  if (!connections.length) return out
  const delivering = await deliveringAdProducts([...new Set(connections.map((c) => c.marketplace))], CATCH_UP_DAYS)
  const oldest = daysBefore(now, CATCH_UP_DAYS)
  const jobs: PullJob[] = await prisma.amazonAdsReportJob.findMany({
    where: { profileId: { in: connections.map((c) => c.profileId) }, endDate: { gte: oldest } },
    select: { profileId: true, adProduct: true, reportTypeId: true, startDate: true, endDate: true, createdAt: true, status: true, ingestedAt: true },
  })

  for (const kind of SETTLE_KINDS) {
    const { from, to } = catchUpBounds(kind.adProduct, now)
    for (const conn of connections) {
      if (!delivering.get(conn.marketplace)?.has(kind.adProduct)) continue
      const key = { profileId: conn.profileId, adProduct: kind.adProduct, reportTypeId: kind.reportTypeId }
      const { days, givenUp } = unsettledDays(jobs, key, from, to, now)
      out.givenUp.push(...givenUp.map((d) => `${conn.marketplace}/${kind.label}: ${d}`))
      if (!days.length) continue
      const asks = kind.ranged
        ? contiguousRuns(days, MAX_RANGE_DAYS)
        : days.map((d) => ({ startDate: d, endDate: d }))
      let asked = 0
      for (const range of asks) {
        if (out.jobsCreated >= maxJobs) { out.capped = true; break }
        const r = await kind.cycle({ ...range, profileIds: [conn.profileId] })
        add(out, r)
        if (r.errors.length) break
        asked += 1
      }
      const left = asks.length - asked
      if (left > 0) out.waiting.push(`${conn.marketplace}/${kind.label}: ${left} ${kind.ranged ? 'range(s)' : 'day(s)'}`)
    }
  }
  if (out.givenUp.length) {
    logger.warn('[ads-report-settle] days whose settling pulls failed twice are no longer asked (their first copy stays)', { givenUp: out.givenUp.slice(0, 40) })
  }
  return out
}

/** The cron's one line. */
export function catchUpSummaryLine(r: CatchUpResult): string {
  return `created=${r.jobsCreated} skipped=${r.jobsSkipped} errors=${r.errors.length} waiting=${r.waiting.length} givenUp=${r.givenUp.length}${r.capped ? ' capped' : ''}`
}

// ── Read: the gap per market ─────────────────────────────────────────────────────────────────────────

export interface CopyTotals {
  salesCents: number
  orders: number
}

export interface MarketVintage {
  market: string
  /** Newest day whose Sponsored Products campaign report holds a settled copy (null: none yet). */
  settledThrough: string | null
  /** Days after this one are still filling: Amazon may still add sales to them. */
  stillFillingFrom: string | null
  /** Campaign days in the window with a first copy (asked within a day) and a settled copy: what the gap is measured on. */
  measured: { campaignDays: number; days: number; firstCopy: CopyTotals; settled: CopyTotals; salesGapPct: number | null; ordersGapPct: number | null } | null
}

interface VintageRow {
  profileId: string
  marketplace: string
  adProduct: string
  entityId: string
  date: Date
  pulledAt: Date
  ageDays: number
  sales7dCents: number | null
  sales14dCents: number | null
  orders7d: number | null
  orders14d: number | null
}

/** A copy's attributed sales and orders: 7 days for Sponsored Products, 14 for Brands and Display. */
function attributed(v: VintageRow): CopyTotals {
  const long = v.adProduct !== 'SPONSORED_PRODUCTS'
  return {
    salesCents: (long ? v.sales14dCents ?? v.sales7dCents : v.sales7dCents) ?? 0,
    orders: (long ? v.orders14d ?? v.orders7d : v.orders7d) ?? 0,
  }
}

const pctMore = (settled: number, first: number): number | null => (first > 0 ? Math.round(((settled - first) / first) * 1000) / 10 : settled > 0 ? null : 0)

/**
 * Pure: the gap over `rows` (vintages of one market) for the days whose report has settled (`settledByKey`: newest
 * settled day per `${profileId}|${adProduct}`). The first copy is the oldest vintage asked within a day; the settled copy
 * is the newest vintage (a re-read that changed nothing keeps no row, so the newest row holds the settled numbers).
 */
export function measureGap(rows: readonly VintageRow[], settledByKey: ReadonlyMap<string, Date>): MarketVintage['measured'] {
  const byDay = new Map<string, VintageRow[]>()
  for (const r of rows) {
    const k = `${r.profileId}|${r.adProduct}|${r.entityId}|${isoDay(r.date)}`
    byDay.set(k, [...(byDay.get(k) ?? []), r])
  }
  const first: CopyTotals = { salesCents: 0, orders: 0 }
  const settled: CopyTotals = { salesCents: 0, orders: 0 }
  const days = new Set<string>()
  let campaignDays = 0
  for (const copies of byDay.values()) {
    const sorted = [...copies].sort((a, b) => a.pulledAt.getTime() - b.pulledAt.getTime())
    const head = sorted[0]
    const last = sorted[sorted.length - 1]
    const through = settledByKey.get(`${head.profileId}|${head.adProduct}`)
    if (!through || utcDay(head.date).getTime() > through.getTime()) continue
    if (head.ageDays > 1) continue
    const a = attributed(head)
    const b = attributed(last)
    first.salesCents += a.salesCents
    first.orders += a.orders
    settled.salesCents += b.salesCents
    settled.orders += b.orders
    days.add(isoDay(head.date))
    campaignDays += 1
  }
  if (!campaignDays) return null
  return {
    campaignDays,
    days: days.size,
    firstCopy: first,
    settled,
    salesGapPct: pctMore(settled.salesCents, first.salesCents),
    ordersGapPct: pctMore(settled.orders, first.orders),
  }
}

/** Per market: the newest settled day and the first-copy-vs-settled gap over [from, to] (YYYY-MM-DD). */
export async function dataVintageByMarket(markets: readonly string[], from: string, to: string): Promise<Map<string, MarketVintage>> {
  const out = new Map<string, MarketVintage>()
  if (!markets.length) return out
  // The account of each market: its ads profile, else its connection (the ingest resolves a report's market the same way).
  const [profiles, conns] = await Promise.all([
    prisma.amazonAdsProfile.findMany({ where: { marketplace: { in: [...markets] } }, select: { profileId: true, marketplace: true } }),
    prisma.amazonAdsConnection.findMany({ where: { marketplace: { in: [...markets] } }, select: { profileId: true, marketplace: true } }),
  ])
  const connections = [...new Map([...conns, ...profiles].map((c) => [`${c.profileId}|${c.marketplace}`, c])).values()]
  const profileIds = [...new Set(connections.map((c) => c.profileId))]
  const since = utcDay(from)
  const until = utcDay(to)
  const [jobs, rows] = await Promise.all([
    profileIds.length
      ? prisma.amazonAdsReportJob.findMany({
          where: { profileId: { in: profileIds }, reportTypeId: { in: Object.values(CAMPAIGN_REPORT_TYPE_ID) }, status: 'COMPLETED', ingestedAt: { not: null }, endDate: { gte: new Date(since.getTime() - CATCH_UP_DAYS * DAY) } },
          select: { profileId: true, adProduct: true, reportTypeId: true, startDate: true, endDate: true, createdAt: true, status: true, ingestedAt: true },
        })
      : Promise.resolve([] as PullJob[]),
    prisma.adsDailyVintage.findMany({
      where: { marketplace: { in: [...markets] }, entityType: 'CAMPAIGN', date: { gte: since, lte: until } },
      select: { profileId: true, marketplace: true, adProduct: true, entityId: true, date: true, pulledAt: true, ageDays: true, sales7dCents: true, sales14dCents: true, orders7d: true, orders14d: true },
    }),
  ])
  for (const market of markets) {
    const mine = connections.filter((c) => c.marketplace === market)
    const settledByKey = new Map<string, Date>()
    for (const c of mine) {
      for (const adProduct of Object.keys(CAMPAIGN_REPORT_TYPE_ID) as AdProduct[]) {
        const s = settledThrough(jobs, { profileId: c.profileId, adProduct, reportTypeId: CAMPAIGN_REPORT_TYPE_ID[adProduct] })
        if (s) settledByKey.set(`${c.profileId}|${adProduct}`, s)
      }
    }
    const sp = mine.map((c) => settledByKey.get(`${c.profileId}|SPONSORED_PRODUCTS`)).filter((d): d is Date => !!d)
    const newest = sp.length ? new Date(Math.max(...sp.map((d) => d.getTime()))) : null
    out.set(market, {
      market,
      settledThrough: newest ? isoDay(newest) : null,
      stillFillingFrom: newest ? isoDay(new Date(newest.getTime() + DAY)) : null,
      measured: measureGap(rows.filter((r) => r.marketplace === market), settledByKey),
    })
  }
  return out
}
