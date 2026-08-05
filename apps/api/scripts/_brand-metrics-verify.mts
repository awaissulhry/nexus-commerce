/** LIVE end-to-end verification of the Brand Metrics pipeline.
 *  Creates real report jobs, polls, ingests, then reads back what landed. */
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)
const svc = await import('../src/services/advertising/ads-brand-metrics.service.js')

const end = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10)
const start = new Date(Date.now() - 44 * 86400000).toISOString().slice(0, 10)
L(`window ${start} .. ${end}`)

L('\n── create ──────────────────────────────────────────────')
const created = await svc.runBrandMetricsCycle({ startDate: start, endDate: end })
L(`created=${created.jobsCreated} skipped=${created.jobsSkipped}`)
for (const e of created.errors) L(`  ⚠️ ${e}`)

L('\n── wait 20s for Amazon to generate ─────────────────────')
await new Promise((r) => setTimeout(r, 20_000))

L('\n── poll + ingest ───────────────────────────────────────')
const out = await svc.runBrandMetricsIngestCycle()
L(`polled=${out.poll.polled} completed=${out.poll.completed} failed=${out.poll.failed} pending=${out.poll.stillPending}`)
L(`rows ingested=${out.ingested}`)
for (const e of out.errors) L(`  ⚠️ ${e}`)

L('\n── debug state (real contract shape) ───────────────────')
L(JSON.stringify(svc.brandMetricsDebugState.last, null, 2)?.slice(0, 900) ?? 'none')

L('\n── what landed in the DB ───────────────────────────────')
const p = prisma as any
const n = await p.amazonAdsBrandBuildingMetric.count()
L(`AmazonAdsBrandBuildingMetric rows: ${n}`)
const rows = await p.amazonAdsBrandBuildingMetric.findMany({
  orderBy: [{ computationDate: 'desc' }], take: 8,
  select: {
    marketplace: true, brandName: true, computationDate: true, lookbackPeriod: true,
    awarenessIndex: true, considerationIndex: true, salesIndex: true,
    brandCustomers: true, addToCarts: true, brandedSearchesOnly: true,
    viewedDetailPageOnly: true, categoryNodeTreeName: true, metrics: true,
  },
})
for (const r of rows) {
  L(`  ${r.marketplace} ${String(r.computationDate).slice(0, 10)} ${r.lookbackPeriod} "${r.brandName.slice(0, 28)}"`)
  L(`     awareness=${r.awarenessIndex} consideration=${r.considerationIndex} sales=${r.salesIndex}`)
  L(`     customers=${r.brandCustomers} addToCarts=${r.addToCarts} brandedSearches=${r.brandedSearchesOnly} dpViews=${r.viewedDetailPageOnly} cat=${r.categoryNodeTreeName}`)
  L(`     raw metric keys: ${Object.keys(r.metrics ?? {}).length}`)
}

L('\n── by marketplace ──────────────────────────────────────')
const byMkt = await p.$queryRawUnsafe(`SELECT "marketplace", COUNT(*)::int AS n, MIN("computationDate")::text AS first, MAX("computationDate")::text AS last FROM "AmazonAdsBrandBuildingMetric" GROUP BY 1 ORDER BY 1`)
for (const r of byMkt as any[]) L(`  ${r.marketplace}  ${String(r.n).padStart(3)} rows  ${r.first} .. ${r.last}`)

L('\n── job outcomes ────────────────────────────────────────')
const jobs = await p.$queryRawUnsafe(`SELECT "status", COUNT(*)::int AS n, SUM("rowsIngested")::int AS rows FROM "AmazonAdsReportJob" WHERE "adProduct"='BRAND_METRICS' GROUP BY 1`)
for (const r of jobs as any[]) L(`  ${String(r.status).padEnd(12)} ${String(r.n).padStart(3)} jobs  ${r.rows} rows`)

await prisma.$disconnect()
