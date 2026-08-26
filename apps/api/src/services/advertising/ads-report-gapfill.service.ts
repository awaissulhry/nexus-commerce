/**
 * Self-healing for the ads report pipeline.
 *
 * The daily crons ask for exactly one day, exactly once. Nothing ever checked
 * whether that day arrived, so a date that produced no rows stayed empty
 * forever. Between 2026-07-28 and 08-04 Italy — the largest market, 52% of all
 * rows — lost seven consecutive days of performance data while spending over
 * €100/day, and every surface reported it as merely "stale". See
 * `ads-sync.job.ts` for the selection bug that caused it.
 *
 * This closes the loop: find days a profile has no rows for, and ask again.
 *
 * Two rules keep it from becoming a request cannon:
 *
 *  1. Only profiles that HAVE campaigns are considered. Five EU profiles
 *     (PL/SE/NL/UK/IE) carry none, so every day is legitimately empty for them —
 *     including them would generate endless jobs that can only ever return zero.
 *  2. Yesterday is never gap-filled. Amazon has not finished the day, and the
 *     normal cron already owns it.
 *
 * ── 🔴 GX.1 — the gap it could not see (2026-08-26) ───────────────────────────
 *
 * The check asked whether a profile-day held ANY row. Two reports write to this
 * table — campaign and advertised-product — so a day whose campaign report landed
 * and whose advertised-product report did NOT was, by that definition, not a gap.
 * It had rows. It was simply missing one of its two grains.
 *
 * Measured on production: 130 days where campaign spend exists and the day holds
 * ZERO `PRODUCT_AD` rows — 59 in July, 70 in June, 51 in April, across all four
 * markets. €4,762 of spend with no product attribution. Every one of them was
 * invisible here, and every one of them makes a campaign→product drill-down read
 * about 80% on any window that includes them.
 *
 * The old comment defended the rule as "a partial day is ambiguous (campaigns
 * pause, budgets exhaust)". That is true of ROW COUNTS and false of GRAIN
 * COVERAGE: if a campaign spent money that day, an advertised product exists by
 * construction, so campaign-rows-with-spend and zero product rows is not
 * ambiguous — it is a report that did not arrive. Gaps are therefore found PER
 * REPORT now, not per day.
 *
 * The other reason they aged out of reach: `lookbackDays` defaults to 14, so a
 * hole is unreachable a fortnight after it opens even though Amazon keeps the
 * data for ~95 days. `maxAgeDays` now bounds requests at the retention wall
 * instead, and a wider sweep can be asked for explicitly.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  createReportJob,
  CAMPAIGN_COLUMNS,
  CAMPAIGN_REPORT_TYPE_ID,
  ADVERTISED_PRODUCT_COLUMNS,
  ADVERTISED_PRODUCT_REPORT_TYPE_ID,
} from './ads-reports.service.js'
import type { AdsRegion } from './ads-api-client.js'

/**
 * What KIND of hole this is, which decides what gets re-requested.
 *
 * `day` — the profile holds no rows at all for that date; ask for both reports.
 * `advertised-product` — campaign rows with spend exist and no PRODUCT_AD rows do;
 *   ask only for the advertised-product report, because the campaign one arrived.
 */
export type GapKind = 'day' | 'advertised-product'

export interface Gap {
  profileId: string
  marketplace: string
  region: string
  date: string
  kind: GapKind
  /**
   * For an `advertised-product` gap, the campaign spend on that day that currently
   * has no product attribution. Reported so a run says what it recovered in money,
   * not only in job counts.
   */
  unattributedSpend: number
}

export interface GapFillResult {
  gapsFound: number
  jobsCreated: number
  jobsSkipped: number
  gaps: Gap[]
  errors: string[]
}

/** Sum of the campaign spend currently carrying no product attribution, across the gaps found. */
export const unattributedSpendOf = (gaps: Gap[]): number =>
  Number(gaps.filter((g) => g.kind === 'advertised-product')
    .reduce((t, g) => t + g.unattributedSpend, 0).toFixed(2))

const MS_DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Amazon's report retention, measured rather than documented.
 *
 * Asking for a start date before the wall is refused outright — the API answers
 * `report type data retention start date` on a 400. Probed 2026-08-20 it sat at
 * 2026-05-17, a rolling ~95 days that moves forward one day per day. Requesting
 * past it only manufactures failed jobs, so every sweep is clamped to it.
 * Deliberately conservative by a couple of days: a job refused at the boundary is
 * a wasted request either way.
 */
export const REPORT_RETENTION_DAYS = 92

/**
 * Days in the trailing window for which a campaign-carrying profile holds no
 * daily-performance rows at all.
 *
 * Deliberately "no rows AT ALL" rather than "fewer rows than usual": a partial
 * day is ambiguous (campaigns pause, budgets exhaust), while a completely empty
 * day for an account with active campaigns is not.
 */
export async function findPerformanceGaps(lookbackDays = 14): Promise<Gap[]> {
  const end = new Date(Date.now() - 2 * MS_DAY)   // never yesterday — Amazon is still settling it
  const wall = new Date(Date.now() - REPORT_RETENTION_DAYS * MS_DAY)
  const wanted = new Date(end.getTime() - (lookbackDays - 1) * MS_DAY)
  // Past the retention wall Amazon refuses the request outright, so never ask.
  const start = wanted < wall ? wall : wanted

  const rows = await prisma.$queryRawUnsafe<Array<{
    profileId: string; marketplace: string; region: string; day: Date
    kind: string; unattributed: number
  }>>(
    `WITH active AS (
       SELECT c."profileId", c."marketplace", c."region",
              -- Does this market have anything that COULD run today?
              EXISTS (SELECT 1 FROM "Campaign" k
                      WHERE k."marketplace" = c."marketplace" AND k."status"::text = 'ENABLED') AS has_enabled
       FROM "AmazonAdsConnection" c
       WHERE c."isActive" = true
         -- only profiles that actually advertise; a campaign-less profile is
         -- empty every day by definition and must never be gap-filled
         AND EXISTS (SELECT 1 FROM "Campaign" k WHERE k."marketplace" = c."marketplace")
     ),
     -- 🔴 GX.1 — IDLE IS NOT BROKEN, and the original guard could not tell them apart.
     --
     -- It admitted any marketplace holding a Campaign row of any status. Spain holds ten and
     -- every one of them is PAUSED: it last spent on 2026-08-21, and the hourly stream — an
     -- entirely separate pipeline — stops on the same day. Every day since is legitimately
     -- empty, and the sweep reported three of them as gaps and would have re-requested them
     -- on every tick forever. A false positive is worse than a false negative here: it burns
     -- a serial queue on reports that can only ever come back empty.
     --
     -- So a market that has nothing enabled is only chased up to the last day it actually
     -- spent. A market WITH an enabled campaign is chased to the end of the window, because
     -- one that should be running and produced nothing is the outage this service exists for.
     lastspend AS (
       SELECT "marketplace", MAX("date") AS last_spend
       FROM "AmazonAdsDailyPerformance"
       WHERE "entityType" = 'CAMPAIGN' AND "costMicros" > 0
         AND "reportRunId" IS DISTINCT FROM 'ams-stream'
       GROUP BY 1
     ),
     days AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS day),
     -- One pass over the window, counting each GRAIN separately. The AMS marker is
     -- excluded because a stream-written row is not evidence that a report arrived —
     -- counting it would hide exactly the hole this is looking for.
     perf AS (
       SELECT p."profileId", p."date",
              COUNT(*) FILTER (WHERE p."entityType" = 'CAMPAIGN')   AS campaign_rows,
              COUNT(*) FILTER (WHERE p."entityType" = 'PRODUCT_AD') AS product_rows,
              COALESCE(SUM(p."costMicros") FILTER (WHERE p."entityType" = 'CAMPAIGN'), 0) AS campaign_cost
       FROM "AmazonAdsDailyPerformance" p
       WHERE p."date" BETWEEN $1::date AND $2::date
         AND p."reportRunId" IS DISTINCT FROM 'ams-stream'
       GROUP BY 1, 2
     )
     SELECT a."profileId", a."marketplace", a."region", d.day,
            CASE WHEN COALESCE(f.campaign_rows, 0) = 0 THEN 'day' ELSE 'advertised-product' END AS kind,
            (COALESCE(f.campaign_cost, 0) / 1000000.0)::float8 AS unattributed
     FROM active a
     CROSS JOIN days d
     LEFT JOIN perf f ON f."profileId" = a."profileId" AND f."date" = d.day
     LEFT JOIN lastspend ls ON ls."marketplace" = a."marketplace"
     WHERE (a.has_enabled OR d.day <= COALESCE(ls.last_spend, d.day - 1))
       AND (COALESCE(f.campaign_rows, 0) = 0
        -- 🔴 The grain gap: money was spent that day and no advertised product carries it.
        -- Unambiguous, unlike a low row count — if a campaign spent, a product was advertised.
        OR (COALESCE(f.product_rows, 0) = 0 AND COALESCE(f.campaign_cost, 0) > 0))
     ORDER BY a."marketplace", d.day`,
    iso(start), iso(end),
  )

  return rows.map((r) => ({
    profileId: r.profileId,
    marketplace: r.marketplace,
    region: r.region,
    date: r.day instanceof Date ? iso(r.day) : String(r.day).slice(0, 10),
    kind: r.kind === 'day' ? 'day' : 'advertised-product',
    unattributedSpend: Number(r.unattributed) || 0,
  }))
}

/**
 * Re-request the reports for every gap found, newest first so the most useful
 * days recover soonest. `maxJobs` bounds a single run — a long outage should
 * heal over several ticks rather than firing hundreds of requests at once and
 * tripping Amazon's rate limits.
 */
export async function runGapFillCycle(args: {
  lookbackDays?: number
  maxJobs?: number
  dryRun?: boolean
} = {}): Promise<GapFillResult> {
  const lookbackDays = args.lookbackDays ?? 14
  const maxJobs = args.maxJobs ?? 30
  const out: GapFillResult = { gapsFound: 0, jobsCreated: 0, jobsSkipped: 0, gaps: [], errors: [] }

  const gaps = await findPerformanceGaps(lookbackDays)
  out.gapsFound = gaps.length
  out.gaps = gaps
  if (!gaps.length) return out

  // Reported by KIND and in money: "23 gaps" says nothing about whether this matters,
  // while "€1,248 of spend with no product attribution" is the thing being recovered.
  const byKind = (k: GapKind) => gaps.filter((g) => g.kind === k)
  logger.warn('[ads-gapfill] performance gaps detected', {
    gaps: gaps.length,
    wholeDays: byKind('day').length,
    productOnly: byKind('advertised-product').length,
    unattributedSpend: Number(byKind('advertised-product').reduce((t, g) => t + g.unattributedSpend, 0).toFixed(2)),
    markets: [...new Set(gaps.map((g) => g.marketplace))].join(','),
  })
  if (args.dryRun) return out

  // Newest first: a hole in yesterday-but-one matters more than one three weeks back.
  const ordered = [...gaps].sort((a, b) => b.date.localeCompare(a.date))

  for (const gap of ordered) {
    if (out.jobsCreated >= maxJobs) break
    const region: AdsRegion = (gap.region === 'NA' || gap.region === 'FE') ? (gap.region as AdsRegion) : 'EU'
    const meta = await prisma.amazonAdsProfile.findUnique({
      where: { profileId: gap.profileId }, select: { currencyCode: true },
    })
    const currencyCode = meta?.currencyCode ?? 'EUR'

    // The two reports that populate AmazonAdsDailyPerformance. Search terms and
    // placement have their own tables and their own gap semantics, so they are
    // intentionally not swept here.
    //
    // GX.1 — a product-only gap asks for ONE report, not both. The campaign report
    // for that day already arrived; re-requesting it would burn a slot in a queue
    // that runs at concurrency 1 and can only overwrite rows with themselves.
    const campaignSpec = {
      reportTypeId: CAMPAIGN_REPORT_TYPE_ID.SPONSORED_PRODUCTS,
      groupBy: ['campaign'], columns: CAMPAIGN_COLUMNS.SPONSORED_PRODUCTS,
    }
    const productSpec = {
      reportTypeId: ADVERTISED_PRODUCT_REPORT_TYPE_ID,
      groupBy: ['advertiser'], columns: ADVERTISED_PRODUCT_COLUMNS,
    }
    const specs = gap.kind === 'advertised-product' ? [productSpec] : [campaignSpec, productSpec]

    for (const s of specs) {
      try {
        const r = await createReportJob({
          profileId: gap.profileId, region, marketplace: gap.marketplace, currencyCode,
          adProduct: 'SPONSORED_PRODUCTS', reportTypeId: s.reportTypeId,
          startDate: gap.date, endDate: gap.date,
          groupBy: s.groupBy, columns: s.columns, timeUnit: 'DAILY',
        })
        if (r.alreadyExisted) out.jobsSkipped += 1
        else out.jobsCreated += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        out.errors.push(`${gap.marketplace} ${gap.date} ${s.reportTypeId}: ${msg.slice(0, 200)}`)
      }
    }
  }

  return out
}
