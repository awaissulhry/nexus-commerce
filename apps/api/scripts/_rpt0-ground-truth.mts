/**
 * RPT.0 — Reporting ground truth. READ-ONLY.
 *
 * Answers the only question that matters before building any report surface:
 * WHICH TABLES ACTUALLY HAVE DATA, over what window, for which marketplaces
 * and ad products — so we never ship a report that looks broken when it is
 * merely empty.
 *
 * Companion to docs/2026-08-04-ads-reporting-rpt.md §5 (RPT.0).
 *
 * Usage: cd apps/api && npx tsx scripts/_rpt0-ground-truth.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const q = <T = Record<string, unknown>>(sql: string) => p.$queryRawUnsafe<T[]>(sql)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const hr = (t: string) => console.log(`\n${'='.repeat(84)}\n${t}\n${'='.repeat(84)}`)

function table(rows: Record<string, unknown>[]) {
  if (!rows.length) return '  (no rows)'
  const cols = Object.keys(rows[0])
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(n(r[c]) ?? '—').length)))
  const line = (cells: string[]) => '  ' + cells.map((s, i) => s.padEnd(w[i])).join('  ')
  return [
    line(cols),
    '  ' + w.map((x) => '-'.repeat(x)).join('  '),
    ...rows.map((r) => line(cols.map((c) => String(n(r[c]) ?? '—')))),
  ].join('\n')
}

/** Total rows + date span + freshness for a date-grained fact table. */
async function span(tbl: string, dateCol: string) {
  const [r] = await q(`
    SELECT COUNT(*)::bigint AS rows,
           MIN("${dateCol}")::date AS first_day,
           MAX("${dateCol}")::date AS last_day,
           COUNT(DISTINCT "${dateCol}"::date)::bigint AS distinct_days,
           (CURRENT_DATE - MAX("${dateCol}")::date)::int AS lag_days
    FROM "${tbl}"`)
  return r
}

/** Rows landing in the trailing window — is the feed still alive? */
async function recent(tbl: string, dateCol: string) {
  const [r] = await q(`
    SELECT COUNT(*) FILTER (WHERE "${dateCol}" >= CURRENT_DATE - 7)::bigint  AS last_7d,
           COUNT(*) FILTER (WHERE "${dateCol}" >= CURRENT_DATE - 30)::bigint AS last_30d,
           COUNT(*) FILTER (WHERE "${dateCol}" >= CURRENT_DATE - 90)::bigint AS last_90d
    FROM "${tbl}"`)
  return r
}

async function factTable(label: string, tbl: string, dateCol: string, dims: string[]) {
  hr(`${label}  —  "${tbl}"`)
  try {
    const s = await span(tbl, dateCol)
    const r = await recent(tbl, dateCol)
    console.log(table([{ ...s, ...r }]))
    if (Number(n((s as Record<string, unknown>).rows)) === 0) {
      console.log('\n  ⚠️  EMPTY — any report built on this ships blank.')
      return
    }
    for (const d of dims) {
      const rows = await q(`
        SELECT COALESCE("${d}"::text, '(null)') AS "${d}",
               COUNT(*)::bigint AS rows,
               MIN("${dateCol}")::date AS first_day,
               MAX("${dateCol}")::date AS last_day,
               COUNT(DISTINCT "${dateCol}"::date)::bigint AS days
        FROM "${tbl}" GROUP BY 1 ORDER BY 2 DESC LIMIT 25`)
      console.log(`\n  by ${d}:`)
      console.log(table(rows))
    }
  } catch (e) {
    console.log(`  ❌ ${(e as Error).message.split('\n')[0]}`)
  }
}

async function jobTable(label: string, tbl: string, extra?: string) {
  hr(`${label}  —  "${tbl}"  (pipeline health)`)
  try {
    const rows = await q(`
      SELECT status,
             COUNT(*)::bigint AS jobs,
             SUM(COALESCE("rowsIngested",0))::bigint AS rows_ingested,
             MAX("createdAt")::date AS last_created
      FROM "${tbl}" GROUP BY 1 ORDER BY 2 DESC`)
    console.log(table(rows))
    const errs = await q(`
      SELECT LEFT(COALESCE("errorMessage",'(none)'), 62) AS error, COUNT(*)::bigint AS n
      FROM "${tbl}" WHERE "errorMessage" IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6`)
    if (errs.length) { console.log('\n  top errors:'); console.log(table(errs)) }
    if (extra) { const x = await q(extra); console.log('\n  breakdown:'); console.log(table(x)) }
  } catch (e) {
    console.log(`  ❌ ${(e as Error).message.split('\n')[0]}`)
  }
}

// ── Fact tables: the reports we could serve ─────────────────────────────────
await factTable('Daily performance (Ads Reports API v3)', 'AmazonAdsDailyPerformance', 'date',
  ['marketplace', 'adProduct', 'entityType'])

await factTable('Hourly performance (Amazon Marketing Stream)', 'AmazonAdsHourlyPerformance', 'date',
  ['marketplace', 'adProduct', 'entityType'])

await factTable('Search terms', 'AmazonAdsSearchTerm', 'date', ['marketplace', 'adProduct', 'matchType'])

await factTable('Placement report', 'AmazonAdsPlacementReport', 'date', ['marketplace', 'adProduct', 'placement'])

await factTable('Search Query Performance (SQP)', 'SearchQueryPerformance', 'startDate',
  ['marketplace', 'reportPeriod'])

await factTable('Brand Metrics', 'AmazonAdsBrandBuildingMetric', 'computationDate',
  ['marketplace', 'lookbackPeriod', 'categoryNodeName'])

await factTable('Economics / net proceeds (Data Kiosk)', 'AmazonEconomicsDaily', 'date', ['marketplace'])

await factTable('Campaign metrics (unified)', 'CampaignMetric', 'date', ['channel', 'marketplace', 'entityType'])

await factTable('eBay listing economics', 'EbayListingEconomics', 'computedAt', ['marketplace', 'dataStatus'])

// ── Job tables: is the pipeline alive? ──────────────────────────────────────
await jobTable('Ads report jobs', 'AmazonAdsReportJob',
  `SELECT "adProduct", "reportTypeId", COUNT(*)::bigint AS jobs,
          SUM(COALESCE("rowsIngested",0))::bigint AS rows_ingested,
          MAX("createdAt")::date AS last_created
   FROM "AmazonAdsReportJob" GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`)

await jobTable('Ads export jobs (Exports API v1)', 'AmazonAdsExportJob')
await jobTable('Data Kiosk query jobs', 'DataKioskQueryJob',
  `SELECT "queryType", "status", COUNT(*)::bigint AS jobs,
          SUM(COALESCE("rowsIngested",0))::bigint AS rows_ingested
   FROM "DataKioskQueryJob" GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`)
await jobTable('eBay ads report tasks', 'EbayAdsReportTask')

// AmazonReportRun uses rowCount, not rowsIngested — handled separately.
hr('SP-API report runs  —  "AmazonReportRun"  (pipeline health)')
try {
  console.log(table(await q(`
    SELECT "reportType", "source", "status", COUNT(*)::bigint AS runs,
           SUM(COALESCE("rowCount",0))::bigint AS rows,
           MAX("freshAsOf")::date AS fresh_as_of
    FROM "AmazonReportRun" GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 25`)))
} catch (e) {
  console.log(`  ❌ ${(e as Error).message.split('\n')[0]}`)
}

// ── Ingest cadence: which crons are actually feeding reporting ──────────────
hr('Reporting-relevant cron activity (last 14 days)  —  "CronRun"')
try {
  console.log(table(await q(`
    SELECT "jobName", COUNT(*)::bigint AS runs,
           COUNT(*) FILTER (WHERE "status" <> 'SUCCESS')::bigint AS non_success,
           MAX("startedAt") AS last_run
    FROM "CronRun"
    WHERE "startedAt" >= NOW() - INTERVAL '14 days'
      AND ("jobName" ILIKE '%report%' OR "jobName" ILIKE '%metric%' OR "jobName" ILIKE '%ingest%'
           OR "jobName" ILIKE '%sqp%' OR "jobName" ILIKE '%kiosk%' OR "jobName" ILIKE '%brand%'
           OR "jobName" ILIKE '%export%' OR "jobName" ILIKE '%stream%' OR "jobName" ILIKE '%tos%')
    GROUP BY 1 ORDER BY 2 DESC LIMIT 30`)))
} catch (e) {
  console.log(`  ❌ ${(e as Error).message.split('\n')[0]}`)
}

await p.$disconnect()
console.log('\nRPT.0 complete — read-only, nothing was modified.\n')
