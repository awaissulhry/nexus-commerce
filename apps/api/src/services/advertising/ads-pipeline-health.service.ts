/**
 * RPT.9 — pipeline health: is every feed landing, how late is it, and what failed.
 *
 * The reporting series measures the DATA; this measures the machinery that
 * produces it. They fail differently: a report can be perfectly correct about a
 * feed that stopped a month ago, which is exactly what happened with the AMS
 * hourly ingest — rejected at the door for a month while every surface showed a
 * healthy-looking table.
 *
 * A feed is late when nothing has landed within its own cadence's grace period,
 * not on a single global threshold: the weekly SQP feed is fine at ten days old
 * and the daily ads feed is not.
 */
import prisma from '../../db.js'

export type FeedStatus = 'ok' | 'late' | 'failing' | 'idle' | 'never'

export interface FeedHealth {
  id: string
  label: string
  source: string
  cadence: 'hourly' | 'daily' | 'weekly'
  /** Cron job that drives it, when there is one. */
  cronJob: string | null
  status: FeedStatus
  /** Newest data day held, not the last time the job ran — they differ, and the
   *  difference is the whole point: a job can succeed and bring back nothing. */
  lastDataDay: string | null
  lagDays: number | null
  rows: number
  /** Last cron outcome, so a green feed with a failing job is still visible. */
  lastRunAt: string | null
  lastRunOk: boolean | null
  recentFailures: number
  note: string | null
}

export interface PipelineHealth {
  asOf: string
  feeds: FeedHealth[]
  jobs: {
    reportJobs: Array<{ status: string; n: number }>
    exportFailures: { total: number; recoverable: number; note: string }
    reportRunsMissingRowCount: { total: number; note: string }
  }
  alerts: string[]
  elapsedMs: number
}

/** Grace period before a feed of this cadence counts as late. */
const GRACE_DAYS: Record<FeedHealth['cadence'], number> = { hourly: 2, daily: 3, weekly: 21 }

const MS_DAY = 86_400_000
const dayOf = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : null

function lagFrom(day: string | null): number | null {
  if (!day) return null
  const t = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(t)) return null
  const now = new Date()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.max(0, Math.round((today - t) / MS_DAY))
}

interface FeedDef {
  id: string
  label: string
  source: string
  cadence: FeedHealth['cadence']
  table: string
  dateCol: string
  cronJob: string | null
  note?: string
}

const FEEDS: FeedDef[] = [
  { id: 'daily-perf', label: 'Ads daily performance', source: 'Ads API v3', cadence: 'daily', table: 'AmazonAdsDailyPerformance', dateCol: 'date', cronJob: 'ads-report-ingest' },
  { id: 'targeting', label: 'Targeting performance', source: 'Ads API v3 · spTargeting', cadence: 'daily', table: 'AmazonAdsDailyPerformance', dateCol: 'date', cronJob: 'ads-report-create-tg', note: 'Newly ingested — history builds from the first run forward.' },
  { id: 'search-terms', label: 'Search terms', source: 'Ads API v3', cadence: 'daily', table: 'AmazonAdsSearchTerm', dateCol: 'date', cronJob: 'ads-report-create-st' },
  { id: 'placement', label: 'Placement', source: 'Ads API v3', cadence: 'daily', table: 'AmazonAdsPlacementReport', dateCol: 'date', cronJob: 'ads-report-create-pl' },
  { id: 'hourly', label: 'Hourly (Marketing Stream)', source: 'AMS → SQS', cadence: 'hourly', table: 'AmazonAdsHourlyPerformance', dateCol: 'date', cronJob: null, note: 'Coverage is per campaign, not per account.' },
  { id: 'sqp', label: 'Search Query Performance', source: 'SP-API Brand Analytics', cadence: 'weekly', table: 'SearchQueryPerformance', dateCol: 'startDate', cronJob: 'sqp-ingest' },
  { id: 'brand-metrics', label: 'Brand Metrics', source: 'Ads API', cadence: 'weekly', table: 'AmazonAdsBrandBuildingMetric', dateCol: 'computationDate', cronJob: 'ads-brand-metrics' },
  { id: 'economics', label: 'Economics (Data Kiosk)', source: 'SP-API Data Kiosk', cadence: 'daily', table: 'AmazonEconomicsDaily', dateCol: 'date', cronJob: null, note: 'Scheduled pull is gated off; current rows came from a manual backfill.' },
]

/** Targeting shares a table with daily performance, so it needs its own predicate. */
const EXTRA_WHERE: Record<string, string> = {
  'daily-perf': `"entityType" IN ('CAMPAIGN','PRODUCT_AD')`,
  targeting: `"entityType" = 'AD_TARGET'`,
}

export async function pipelineHealth(): Promise<PipelineHealth> {
  const started = Date.now()

  // One pass, not a correlated subquery per job. The first version re-counted
  // failures for every DISTINCT ON group and took SIX AND A HALF MINUTES on a
  // table this size — a health page that takes longer than the outage it
  // reports is not a health page. Only the feeds' own cron jobs are scanned.
  const cronNames = FEEDS.map((f) => f.cronJob).filter((n): n is string => !!n)
  const cronRows = cronNames.length
    ? await prisma.$queryRawUnsafe<Array<{ jobName: string; last_run: Date; failures: number; last_status: string }>>(`
        WITH recent AS (
          SELECT "jobName", "startedAt", "status"
          FROM "CronRun"
          WHERE "startedAt" > NOW() - INTERVAL '14 days'
            AND "jobName" = ANY($1::text[])
        ),
        latest AS (
          SELECT DISTINCT ON ("jobName") "jobName", "startedAt" AS last_run, "status" AS last_status
          FROM recent ORDER BY "jobName", "startedAt" DESC
        ),
        fails AS (
          SELECT "jobName", COUNT(*)::int AS failures
          FROM recent
          WHERE "status" <> 'SUCCESS' AND "startedAt" > NOW() - INTERVAL '3 days'
          GROUP BY 1
        )
        SELECT l."jobName", l.last_run, l.last_status, COALESCE(f.failures, 0) AS failures
        FROM latest l LEFT JOIN fails f ON f."jobName" = l."jobName"`, cronNames)
    : []
  const cronByName = new Map(cronRows.map((r) => [r.jobName, r]))

  const feeds: FeedHealth[] = []
  for (const f of FEEDS) {
    const where = EXTRA_WHERE[f.id] ? `WHERE ${EXTRA_WHERE[f.id]}` : ''
    let lastDataDay: string | null = null
    let rows = 0
    try {
      const r = await prisma.$queryRawUnsafe<Array<{ last: Date | null; n: number }>>(
        `SELECT MAX("${f.dateCol}") AS last, COUNT(*)::int AS n FROM "${f.table}" ${where}`)
      lastDataDay = dayOf(r[0]?.last)
      rows = Number(r[0]?.n ?? 0)
    } catch {
      /* a missing table must not blank the whole page */
    }
    const lagDays = lagFrom(lastDataDay)
    const cron = f.cronJob ? cronByName.get(f.cronJob) : undefined
    const recentFailures = Number(cron?.failures ?? 0)

    let status: FeedStatus
    if (rows === 0) status = 'never'
    else if (recentFailures > 0) status = 'failing'
    else if (lagDays != null && lagDays > GRACE_DAYS[f.cadence]) status = 'late'
    else status = 'ok'

    feeds.push({
      id: f.id, label: f.label, source: f.source, cadence: f.cadence, cronJob: f.cronJob,
      status, lastDataDay, lagDays, rows,
      lastRunAt: cron?.last_run ? cron.last_run.toISOString() : null,
      lastRunOk: cron ? cron.last_status === 'SUCCESS' : null,
      recentFailures,
      note: f.note ?? null,
    })
  }

  const [reportJobs, exportFail, missingRowCount] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ status: string; n: number }>>(
      `SELECT "status", COUNT(*)::int AS n FROM "AmazonAdsReportJob" GROUP BY 1 ORDER BY 2 DESC`),
    prisma.$queryRawUnsafe<Array<{ total: number; recoverable: number }>>(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE "completedAt" > NOW() - INTERVAL '1 day')::int AS recoverable
      FROM "AmazonAdsExportJob"
      WHERE "rowsIngested" = 0 AND "errorMessage" ILIKE '%s3_download%'`),
    prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM "AmazonReportRun" WHERE "status" = 'DONE' AND "rowCount" IS NULL`),
  ])

  const alerts: string[] = []
  for (const f of feeds) {
    if (f.status === 'late') alerts.push(`${f.label} is ${f.lagDays} days behind — expected within ${GRACE_DAYS[f.cadence]} for a ${f.cadence} feed.`)
    if (f.status === 'failing') alerts.push(`${f.label}: ${f.recentFailures} cron failure(s) in the last 3 days (${f.cronJob}).`)
    if (f.status === 'never') alerts.push(`${f.label} has never produced a row.`)
  }

  const ef = exportFail[0]
  return {
    asOf: new Date().toISOString(),
    feeds,
    jobs: {
      reportJobs: reportJobs.map((r) => ({ status: r.status, n: Number(r.n) })),
      exportFailures: {
        total: Number(ef?.total ?? 0),
        recoverable: Number(ef?.recoverable ?? 0),
        note: 'Amazon stops serving an export after roughly a day, so only the most recent are recoverable. Ingest now re-mints the link inline, which stops new losses.',
      },
      reportRunsMissingRowCount: {
        total: Number(missingRowCount[0]?.n ?? 0),
        note: 'Historic runs recorded before row counts were captured. New runs record one.',
      },
    },
    alerts,
    elapsedMs: Date.now() - started,
  }
}
