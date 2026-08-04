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

export interface Gap {
  profileId: string
  marketplace: string
  region: string
  date: string
}

export interface GapFillResult {
  gapsFound: number
  jobsCreated: number
  jobsSkipped: number
  gaps: Gap[]
  errors: string[]
}

const MS_DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)

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
  const start = new Date(end.getTime() - (lookbackDays - 1) * MS_DAY)

  const rows = await prisma.$queryRawUnsafe<Array<{ profileId: string; marketplace: string; region: string; day: Date }>>(
    `WITH active AS (
       SELECT c."profileId", c."marketplace", c."region"
       FROM "AmazonAdsConnection" c
       WHERE c."isActive" = true
         -- only profiles that actually advertise; a campaign-less profile is
         -- empty every day by definition and must never be gap-filled
         AND EXISTS (SELECT 1 FROM "Campaign" k WHERE k."marketplace" = c."marketplace")
     ),
     days AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS day)
     SELECT a."profileId", a."marketplace", a."region", d.day
     FROM active a CROSS JOIN days d
     WHERE NOT EXISTS (
       SELECT 1 FROM "AmazonAdsDailyPerformance" p
       WHERE p."profileId" = a."profileId" AND p."date" = d.day
     )
     ORDER BY a."marketplace", d.day`,
    iso(start), iso(end),
  )

  return rows.map((r) => ({
    profileId: r.profileId,
    marketplace: r.marketplace,
    region: r.region,
    date: r.day instanceof Date ? iso(r.day) : String(r.day).slice(0, 10),
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

  logger.warn('[ads-gapfill] performance gaps detected', {
    gaps: gaps.length,
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
    const specs = [
      {
        reportTypeId: CAMPAIGN_REPORT_TYPE_ID.SPONSORED_PRODUCTS,
        groupBy: ['campaign'], columns: CAMPAIGN_COLUMNS.SPONSORED_PRODUCTS,
      },
      {
        reportTypeId: ADVERTISED_PRODUCT_REPORT_TYPE_ID,
        groupBy: ['advertiser'], columns: ADVERTISED_PRODUCT_COLUMNS,
      },
    ]

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
