/**
 * SPC.3 — backfill the widened spCampaigns columns across everything Amazon will
 * still serve. Resumable, idempotent, and safe to re-run.
 *
 *   cd apps/api && NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx \
 *     scripts/_spc3-backfill.mts [MARKET ...]
 *
 * ── The two ceilings this is built around, measured 2026-08-20 ──────────────────
 *
 *   · `report type data retention start date` — a ROLLING ~95 days. Anything older
 *     is refused outright, so 1,092 campaign rows (2026-03-22 → 05-16) can never
 *     carry these columns. The wall is recomputed on every run, not hard-coded,
 *     because it moves forward a day at a time.
 *   · `maximum range` — 31 days per report. 95 days is therefore THREE windows per
 *     profile, twelve jobs for the four live markets. Not the 600 single-day jobs
 *     the plan feared, which at Amazon's serial concurrency of 1 would have been
 *     about nine days of queue.
 *
 * ── Why re-running is safe, and why it may be necessary ─────────────────────────
 *
 * 🔴 Production is still running the PRE-SPC.1 ingest. Its poller runs every 15
 * minutes and will happily ingest these jobs first, writing the OLD column subset
 * and stamping `ingestedAt`. That loses nothing permanent — `ingestCompletedJob`
 * does not check `ingestedAt`, so re-ingesting the same job fills the new columns
 * — but only while the presigned URL lives. Measured: alive at 16 minutes, dead
 * (403) at 8 hours.
 *
 * So the script verifies by DATA rather than by job status: after each window it
 * counts rows still missing `entityName`, which only the new ingest writes. A
 * window that lost the race is simply requested again on the next run. Nothing is
 * ever double-counted, because the ingest upserts on
 * (profileId, adProduct, entityType, entityId, date).
 */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const svc = await import('../src/services/advertising/ads-reports.service.js')
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

/**
 * 🔴 Retry every database call in the polling loop.
 *
 * The first run of this script died at 960s with `Connection terminated due to
 * connection timeout`: Neon drops an idle pooled connection, and a loop that waits
 * 20 minutes for one Amazon report will hit that reliably. A twelve-job backfill
 * spends hours in this loop, so an unguarded query is a guaranteed crash — and the
 * crash is what makes it look like the backfill failed when the job is fine.
 */
async function retry<T>(what: string, fn: () => Promise<T>, tries = 4): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) {
      const msg = (e as Error).message.slice(0, 90)
      if (i === tries - 1) { console.log(`  ${what} failed after ${tries}: ${msg}`); return null }
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)))
    }
  }
  return null
}

const MS_DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)
/** One day of margin under the 95-day wall, so a run straddling midnight cannot 400. */
const RETENTION_DAYS = 94
const MAX_RANGE = 31

const wall = new Date(Date.now() - RETENTION_DAYS * MS_DAY)
const lastSettled = new Date(Date.now() - MS_DAY)

/** [start, end] pairs covering the reachable span, none exceeding the range cap. */
function windows(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let cur = new Date(wall)
  while (cur <= lastSettled) {
    const end = new Date(Math.min(cur.getTime() + MAX_RANGE * MS_DAY, lastSettled.getTime()))
    out.push([iso(cur), iso(end)])
    cur = new Date(end.getTime() + MS_DAY)
  }
  return out
}

const only = process.argv.slice(2).filter((a) => /^[A-Z]{2}$/.test(a))
const profiles = await prisma.amazonAdsConnection.findMany({
  where: { isActive: true, ...(only.length ? { marketplace: { in: only } } : {}) },
  select: { profileId: true, marketplace: true, region: true },
})
// Only markets that actually have campaigns; the other five EU profiles carry none
// and every report for them is legitimately empty.
const live: typeof profiles = []
for (const p of profiles) {
  const n = await prisma.campaign.count({ where: { marketplace: p.marketplace } })
  if (n > 0) live.push(p); else console.log(`skip ${p.marketplace} — no campaigns`)
}

const W = windows()
console.log(`wall ${iso(wall)} → ${iso(lastSettled)} · ${W.length} windows × ${live.length} markets = ${W.length * live.length} jobs`)
W.forEach(([a, b], i) => console.log(`  W${i + 1} ${a} → ${b}`))

/**
 * Rows in a window the NEW ingest has not written. `entityName` is the marker.
 *
 * 🔴 Excludes the Marketing Stream's daily rows. They are `profileId:'ams'`,
 * `reportRunId:'ams-stream'` leftovers that no report can fill — the v3 report has
 * nothing to say about them — so counting them made the first IT window read
 * "243 still unfilled" forever and re-request itself on every run. Same marker the
 * report specs and five other services exclude on (AX2.3).
 */
async function unfilled(marketplace: string, from: string, to: string): Promise<number> {
  const r = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int n FROM "AmazonAdsDailyPerformance"
     WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS'
       AND "marketplace"=$1 AND "date" BETWEEN $2::date AND $3::date
       AND "entityName" IS NULL AND "reportRunId" IS DISTINCT FROM 'ams-stream'`,
    marketplace, from, to)
  return Number(r[0]?.n ?? 0)
}

for (const p of live) {
  for (const [from, to] of W) {
    const before = await unfilled(p.marketplace, from, to)
    if (before === 0) { console.log(`\n${p.marketplace} ${from}→${to}: already filled, skipping`); continue }
    console.log(`\n${p.marketplace} ${from}→${to}: ${before} rows unfilled`)
    let jobId: string
    try {
      const job = await svc.createReportJob({
        profileId: p.profileId, region: (p.region as 'EU') ?? 'EU', marketplace: p.marketplace,
        currencyCode: 'EUR', adProduct: 'SPONSORED_PRODUCTS',
        reportTypeId: svc.CAMPAIGN_REPORT_TYPE_ID.SPONSORED_PRODUCTS,
        startDate: from, endDate: to, groupBy: ['campaign'],
        columns: svc.CAMPAIGN_COLUMNS.SPONSORED_PRODUCTS, timeUnit: 'DAILY',
      })
      jobId = job.jobId
      console.log(`  job ${jobId} ${job.status}${job.alreadyExisted ? ' (reused)' : ''}`)
    } catch (e) { console.log(`  CREATE FAILED: ${(e as Error).message.slice(0, 220)}`); continue }

    /**
     * Poll Amazon for THIS report only.
     *
     * `pollPendingJobs()` sweeps every pending job in the account and writes to all
     * of them — which duplicates exactly what production's own poller is doing every
     * 15 minutes, and multiplies the database traffic in a loop that already proved
     * fragile. One GET for one reportId is all this needs.
     *
     * 🔴 Amazon returns the download link as `url`, never `location` — reading the
     * v2 spelling here is a documented past defect: the job goes COMPLETED with a
     * null location and ingest then refuses it as "not ingestable".
     */
    const ext = await retry('read job', () => prisma.amazonAdsReportJob.findUnique({
      where: { id: jobId }, select: { externalReportId: true },
    }))
    if (!ext?.externalReportId) { console.log('  no externalReportId — skipping'); continue }

    let done = false
    for (let i = 0; i < 120 && !done; i++) {
      await new Promise((r) => setTimeout(r, 20_000))
      const st = await retry('poll', () => liveCall<{ status?: string; url?: string; fileSize?: number }>({
        profileId: p.profileId, region: (p.region as 'EU') ?? 'EU', method: 'GET',
        path: `/reporting/reports/${ext.externalReportId}`, skipCallLog: true,
      }))
      const upper = st?.status?.toUpperCase() ?? 'UNKNOWN'
      if (upper === 'COMPLETED' && st?.url) {
        await retry('save location', () => prisma.amazonAdsReportJob.update({
          where: { id: jobId },
          data: { status: 'COMPLETED', location: st.url, fileSize: st.fileSize ?? null, completedAt: new Date() },
        }))
        done = true
      } else if (upper === 'FAILED') { console.log('  FAILED at Amazon'); break }
      else if (i % 6 === 5) console.log(`    ${(i + 1) * 20}s ${upper}`)
    }
    if (!done) { console.log('  still not ready — re-run to pick it up'); continue }

    const res = await retry('ingest', () => svc.ingestCompletedJob(jobId))
    if (!res) continue
    const after = (await retry('recount', () => unfilled(p.marketplace, from, to))) ?? -1
    console.log(`  ingested ${res.rowsIngested} rows · unfilled ${before} → ${after}${res.error ? ` · ${res.error}` : ''}`)
  }
}

console.log('\n── coverage of the new columns, all markets ──')
const cov = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "marketplace", COUNT(*)::int rows,
         COUNT("entityName")::int named,
         COUNT("salesSameSku7dCents")::int samesku,
         COUNT("campaignBudgetCents")::int budget,
         MIN("date")::text first, MAX("date")::text last
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS'
  GROUP BY 1 ORDER BY 2 DESC`)
console.table(cov)
await prisma.$disconnect()
