/**
 * HV.2a — is the search-term feed stalled, or is 2 days its normal lag? READ-ONLY.
 *
 * 🔴 HV.1 wrote that "`ads-v1-export-ingest` has returned ingested=0 rows=0 on every run since
 * 2026-08-11T01:52", and implied that was why `AmazonAdsSearchTerm` is 2 days old. **That job does
 * not carry search terms.** `ads-v1-export-ingest` (ads-sync.job.ts:604) drains
 * `AmazonAdsExportJob` — the v1 unified export of STRUCTURE data (campaigns, ad groups, targets,
 * ads). The search-term chain is a different pipeline entirely:
 *
 *     ads-report-create-st  →  ads-report-poll  →  ads-report-ingest
 *
 * So HV.1 read the right symptom off the wrong job. This script measures the right one.
 *
 * The decisive question is NOT "what is MAX(date) today" — it is **"how long has this feed EVER
 * taken to deliver a given calendar date?"** Amazon search-term data is provisional for 1-2 days,
 * so a 2-day lag may be the feed working exactly as designed. Measured per date via
 * MIN(createdAt) - date, which is the observed delivery lag and cannot be argued with.
 *
 * NOTHING IS MODIFIED. No job is run, no report requested, no env var touched.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const day = (d: Date) => d.toISOString().slice(0, 10)
const now = Date.now()

console.log('\n═══ HV.2a — the search-term ingest, measured ═══\n')

// ── 1 · the chain's cron records ──────────────────────────────────────────────
console.log('═══ 1 · the crons, newest first ═══\n')
for (const jobName of ['ads-report-create-st', 'ads-report-poll', 'ads-report-ingest', 'ads-v1-export-ingest', 'ads-search-term-cleanup']) {
  const runs = await prisma.cronRun.findMany({
    where: { jobName }, orderBy: { startedAt: 'desc' }, take: 8,
    select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
  })
  const total = await prisma.cronRun.count({ where: { jobName } })
  console.log(`\n── ${jobName} (${int(total)} runs all time)`)
  if (!runs.length) { console.log('   NO RUNS RECORDED'); continue }
  for (const r of runs) {
    console.log(`   ${pad(r.startedAt.toISOString().slice(0, 16), 18)} ${pad(r.status, 8)} ${(r.outputSummary ?? '').slice(0, 110)}${r.errorMessage ? `  ERR: ${r.errorMessage.slice(0, 60)}` : ''}`)
  }
  // the last run that reported a non-zero row count
  const recent = await prisma.cronRun.findMany({
    where: { jobName }, orderBy: { startedAt: 'desc' }, take: 400,
    select: { startedAt: true, outputSummary: true },
  })
  const nonZero = recent.find((r) => {
    const m = (r.outputSummary ?? '').match(/rows?=(\d+)/)
    return m && Number(m[1]) > 0
  })
  console.log(`   last run reporting rows>0: ${nonZero ? `${nonZero.startedAt.toISOString().slice(0, 16)}  "${nonZero.outputSummary}"` : 'none in the last 400 runs'}`)
}

// ── 2 · the three ads feeds, per day ──────────────────────────────────────────
console.log('\n\n═══ 2 · one feed or all three? ═══\n')
const since30 = new Date(now - 30 * 86_400_000)
const feeds: Array<[string, () => Promise<Array<{ date: Date; _count: number }>>, () => Promise<{ _max: { date: Date | null; createdAt: Date | null }; _count: number }>]> = [
  ['AmazonAdsSearchTerm',
    () => prisma.amazonAdsSearchTerm.groupBy({ by: ['date'], where: { date: { gte: since30 } }, _count: true, orderBy: { date: 'desc' } }) as never,
    () => prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true, createdAt: true }, _count: true }) as never],
  ['AmazonAdsDailyPerformance',
    () => prisma.amazonAdsDailyPerformance.groupBy({ by: ['date'], where: { date: { gte: since30 } }, _count: true, orderBy: { date: 'desc' } }) as never,
    () => prisma.amazonAdsDailyPerformance.aggregate({ _max: { date: true, createdAt: true }, _count: true }) as never],
  ['AmazonAdsPlacementReport',
    () => prisma.amazonAdsPlacementReport.groupBy({ by: ['date'], where: { date: { gte: since30 } }, _count: true, orderBy: { date: 'desc' } }) as never,
    () => prisma.amazonAdsPlacementReport.aggregate({ _max: { date: true, createdAt: true }, _count: true }) as never],
]
for (const [name, byDay, agg] of feeds) {
  try {
    const a = await agg()
    const rows = await byDay()
    const ageD = a._max.date ? Math.floor((now - a._max.date.getTime()) / 86_400_000) : null
    console.log(`\n── ${name}: ${int(a._count)} rows · MAX(date)=${a._max.date ? day(a._max.date) : '—'} (${ageD} days old) · newest row written ${a._max.createdAt?.toISOString() ?? '—'}`)
    console.log(`   last 10 dates: ${rows.slice(0, 10).map((r) => `${day(r.date)}=${r._count}`).join(' · ')}`)
  } catch (e) { console.log(`\n── ${name}: ${(e as Error).message.slice(0, 120)}`) }
}

// ── 3 · 🔴 THE DECISIVE ONE — the delivery lag, historically ──────────────────
console.log('\n\n═══ 3 · how long has this feed ALWAYS taken? ═══\n')
console.log('per calendar date: when were its rows FIRST written? lag = MIN(createdAt) − date\n')
const st = await prisma.$queryRaw<Array<{ d: Date; first_seen: Date; last_seen: Date; n: bigint }>>`
  SELECT date AS d, MIN("createdAt") AS first_seen, MAX("createdAt") AS last_seen, COUNT(*)::bigint AS n
  FROM "AmazonAdsSearchTerm"
  WHERE date >= NOW() - INTERVAL '30 days'
  GROUP BY date ORDER BY date DESC
`
console.log(`${pad('date', 12)} ${pad('rows', 7)} ${pad('first written', 18)} ${pad('lag', 8)} last written`)
const lags: number[] = []
for (const r of st) {
  const lagH = (r.first_seen.getTime() - r.d.getTime()) / 3_600_000
  lags.push(lagH)
  console.log(`${pad(day(r.d), 12)} ${pad(int(Number(r.n)), 7)} ${pad(r.first_seen.toISOString().slice(0, 16), 18)} ${pad(`${(lagH / 24).toFixed(1)}d`, 8)} ${r.last_seen.toISOString().slice(0, 16)}`)
}
if (lags.length) {
  const sorted = [...lags].sort((a, b) => a - b)
  const p = (q: number) => sorted[Math.floor(sorted.length * q)] / 24
  console.log(`\ndelivery lag over ${lags.length} dates — min ${p(0).toFixed(1)}d · median ${p(0.5).toFixed(1)}d · p90 ${p(0.9).toFixed(1)}d · max ${(sorted[sorted.length - 1] / 24).toFixed(1)}d`)
  console.log(`⇒ if today's 2-day gap sits inside that distribution, the feed is behaving normally and`)
  console.log(`  the page must describe the lag rather than call it a stall.`)
}

// ── 4 · the report registry ───────────────────────────────────────────────────
console.log('\n\n═══ 4 · AmazonReportRun — requested but never retrieved? ═══\n')
const since7 = new Date(now - 7 * 86_400_000)
const byTypeStatus = await prisma.amazonReportRun.groupBy({
  by: ['reportType', 'status'], where: { requestedAt: { gte: since7 } }, _count: true,
})
if (!byTypeStatus.length) console.log('   no AmazonReportRun rows in the last 7 days')
console.log(`${pad('reportType', 46)} ${pad('status', 13)} n`)
for (const r of byTypeStatus.sort((a, b) => a.reportType.localeCompare(b.reportType))) {
  console.log(`${pad(r.reportType, 46)} ${pad(r.status, 13)} ${r._count}`)
}
console.log('\nfreshAsOf + newest run per report type (last 7d):')
const types = [...new Set(byTypeStatus.map((r) => r.reportType))]
for (const t of types) {
  const newest = await prisma.amazonReportRun.findFirst({
    where: { reportType: t }, orderBy: { requestedAt: 'desc' },
    select: { requestedAt: true, completedAt: true, status: true, freshAsOf: true, rowCount: true, dataStartTime: true, dataEndTime: true, errorMessage: true, marketplace: true },
  })
  if (!newest) continue
  console.log(`  ${pad(t, 44)} ${pad(newest.status, 11)} req ${newest.requestedAt.toISOString().slice(0, 16)} · window ${newest.dataStartTime ? day(newest.dataStartTime) : '—'}→${newest.dataEndTime ? day(newest.dataEndTime) : '—'} · rows ${newest.rowCount ?? '—'} · freshAsOf ${newest.freshAsOf ? newest.freshAsOf.toISOString().slice(0, 16) : '—'}${newest.errorMessage ? ` · ERR ${newest.errorMessage.slice(0, 50)}` : ''}`)
}

// stuck: requested a while ago, never completed
const stuck = await prisma.amazonReportRun.findMany({
  where: { status: { in: ['REQUESTED', 'IN_PROGRESS'] }, requestedAt: { lt: new Date(now - 6 * 3_600_000) } },
  orderBy: { requestedAt: 'desc' }, take: 15,
  select: { reportType: true, status: true, requestedAt: true, marketplace: true, reportId: true },
})
console.log(`\nrequested >6h ago and still not DONE: ${stuck.length}`)
for (const s of stuck) console.log(`  ${pad(s.reportType, 44)} ${pad(s.status, 12)} ${s.requestedAt.toISOString().slice(0, 16)} ${s.marketplace ?? ''} ${s.reportId ?? '(no reportId)'}`)

// ── 5 · did the requested WINDOW change in the last 7 days? ────────────────────
console.log('\n\n═══ 5 · did the requested window / type / profile set change? ═══\n')
const stRuns = await prisma.amazonReportRun.findMany({
  where: { requestedAt: { gte: since7 }, reportType: { contains: 'SEARCH_TERM' } },
  orderBy: { requestedAt: 'desc' }, take: 25,
  select: { requestedAt: true, status: true, dataStartTime: true, dataEndTime: true, marketplace: true, rowCount: true, errorMessage: true, reportId: true },
})
console.log(`SEARCH_TERM report runs in the last 7 days: ${stRuns.length}`)
for (const r of stRuns) {
  console.log(`  ${r.requestedAt.toISOString().slice(0, 16)} ${pad(r.status, 11)} ${pad(r.marketplace ?? 'all', 6)} window ${r.dataStartTime ? day(r.dataStartTime) : '—'}→${r.dataEndTime ? day(r.dataEndTime) : '—'} rows ${r.rowCount ?? '—'}${r.errorMessage ? ` ERR ${r.errorMessage.slice(0, 50)}` : ''}`)
}

// ── 6 · export-job backlog, for the job HV.1 actually named ───────────────────
console.log('\n\n═══ 6 · ads-v1-export-ingest — the job HV.1 named, and what it really carries ═══\n')
const jobsByStatus = await prisma.amazonAdsExportJob.groupBy({ by: ['status'], _count: true })
console.log(`AmazonAdsExportJob by status: ${jobsByStatus.map((j) => `${j.status}=${j._count}`).join(' · ')}`)
const ingestable = await prisma.amazonAdsExportJob.count({
  where: { status: 'COMPLETED', url: { not: null }, rowsIngested: 0, fileSize: { gte: 100 }, OR: [{ urlExpiresAt: null }, { urlExpiresAt: { gt: new Date() } }] },
})
console.log(`jobs matching the ingest cron's WHERE (COMPLETED · url · rowsIngested=0 · fileSize≥100 · url unexpired): ${ingestable}`)
console.log('⇒ rows=0 here means "no export job was waiting", i.e. the STRUCTURE pipeline is caught up.')
console.log('  It says nothing whatever about search terms.')

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
