/**
 * _sqp1-lastruns.mts — SQP.1 Phase A, the decisive slice: the two zero-yield runs, report by report.
 *
 * 🔴 READ-ONLY. No Amazon call, no write.
 *
 * _sqp1-diagnose.mts established the SHAPE (1549 empty reports, 129 that never came back) but
 * aggregated every run that ever touched a window, so it cannot say what the last two runs did.
 * This one slices by the CronRun's own [startedAt, finishedAt] so each nightly run is measured
 * separately — including 2026-08-10, which wrote 83 rows and is therefore the control.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp1-lastruns.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { SQP_REPORT_TYPE } from '../src/services/advertising/sqp.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const ts = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(11, 19) : '—')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const secs = (ms: number) => `${(ms / 1000).toFixed(0)}s`
const pctl = (xs: number[], p: number) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function main() {
  const mkts = await prisma.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { code: true, marketplaceId: true } })
  const codeOf = new Map(mkts.filter((m) => m.marketplaceId).map((m) => [m.marketplaceId!, m.code]))

  const runs = await prisma.cronRun.findMany({
    where: { jobName: 'sqp-ingest', finishedAt: { not: null } },
    select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true },
    orderBy: { startedAt: 'desc' },
    take: 10,
  })

  h('per-RUN truth — one nightly run per block, newest first')
  for (const run of runs) {
    const dur = (+run.finishedAt! - +run.startedAt) / 60_000
    const reports = await prisma.amazonReportRun.findMany({
      where: { reportType: SQP_REPORT_TYPE, requestedAt: { gte: run.startedAt, lte: run.finishedAt! } },
      select: { marketplace: true, status: true, rowCount: true, errorMessage: true, dataStartTime: true, requestedAt: true, completedAt: true, reportId: true },
      orderBy: { requestedAt: 'asc' },
    })
    const done = reports.filter((r) => r.status === 'DONE')
    const empty = done.filter((r) => (r.rowCount ?? 0) === 0)
    const populated = done.filter((r) => (r.rowCount ?? 0) > 0)
    const notDone = reports.filter((r) => r.status !== 'DONE')
    const timeouts = notDone.filter((r) => /did not reach DONE within/.test(r.errorMessage ?? ''))
    const lat = reports.filter((r) => r.completedAt).map((r) => +r.completedAt! - +r.requestedAt)
    const windows = [...new Set(reports.map((r) => d10(r.dataStartTime)))].sort()

    line()
    line(`${d10(run.startedAt)}  ${run.status}  ${dur.toFixed(1)}m  "${run.outputSummary ?? ''}"${run.errorMessage ? `  ⚠ ${run.errorMessage}` : ''}`)
    line(`  reports attempted ${reports.length} · DONE ${done.length} (populated ${populated.length}, empty ${empty.length}) · not-DONE ${notDone.length} (poll timeouts ${timeouts.length})`)
    line(`  rows parsed by Amazon: ${done.reduce((a, r) => a + (r.rowCount ?? 0), 0)} · windows requested: ${windows.join(', ')}`)
    if (lat.length) line(`  per-report wall time: p50 ${secs(pctl(lat, 50)!)} · p90 ${secs(pctl(lat, 90)!)} · max ${secs(Math.max(...lat))} · SUM ${(lat.reduce((a, b) => a + b, 0) / 60_000).toFixed(1)}m of the ${dur.toFixed(1)}m run`)
    const byMkt = new Map<string, { n: number; done: number; rows: number; to: number }>()
    for (const r of reports) {
      const k = codeOf.get(r.marketplace ?? '') ?? r.marketplace ?? '?'
      const e = byMkt.get(k) ?? { n: 0, done: 0, rows: 0, to: 0 }
      e.n++
      if (r.status === 'DONE') { e.done++; e.rows += r.rowCount ?? 0 }
      if (/did not reach DONE within/.test(r.errorMessage ?? '')) e.to++
      byMkt.set(k, e)
    }
    line(`  per market: ${[...byMkt].sort().map(([k, e]) => `${k} ${e.done}/${e.n} DONE, ${e.rows} rows, ${e.to} timeout`).join(' · ')}`)
    const errs = new Map<string, number>()
    for (const r of reports) if (r.errorMessage && !/did not reach DONE within/.test(r.errorMessage)) errs.set(r.errorMessage.slice(0, 100), (errs.get(r.errorMessage.slice(0, 100)) ?? 0) + 1)
    for (const [m, n] of errs) line(`  other error ×${n}: ${m}`)
  }

  // ── the refresh_token errors — when? ────────────────────────────────────────────────────────
  h('the invalid-grant refresh_token errors — when did they happen, and to what?')
  const grantErrs = await prisma.amazonReportRun.findMany({
    where: { errorMessage: { contains: 'invalid grant parameter' } },
    select: { reportType: true, marketplace: true, requestedAt: true, triggeredBy: true },
    orderBy: { requestedAt: 'desc' },
    take: 40,
  })
  line(`AmazonReportRun rows with an invalid-grant error: ${grantErrs.length}`)
  for (const g of grantErrs.slice(0, 20)) {
    line(`  ${d10(g.requestedAt)} ${ts(g.requestedAt)}  ${padr(codeOf.get(g.marketplace ?? '') ?? g.marketplace ?? '?', 6)} ${padr(g.triggeredBy ?? '—', 8)} ${g.reportType.replace('GET_', '').slice(0, 40)}`)
  }
  const newestGrant = grantErrs[0]?.requestedAt
  line(newestGrant
    ? `⇒ newest invalid-grant ${d10(newestGrant)} — ${(Date.now() - +newestGrant) / 86_400_000 > 7 ? '✓ older than a week; NOT the current cause' : '🔴 within the last week; the refresh token is a live suspect'}`
    : '⇒ none')

  // ── the poll loop, seen from the HTTP side, for the two zero runs ───────────────────────────
  h('the poll loop during the two zero-yield runs — from OutboundApiCallLog')
  for (const run of runs.slice(0, 4)) {
    const calls = await prisma.outboundApiCallLog.findMany({
      where: { channel: 'AMAZON', operation: { in: ['createReport', 'getReport', 'getReportDocument'] }, createdAt: { gte: run.startedAt, lte: run.finishedAt! } },
      select: { operation: true, success: true, statusCode: true, latencyMs: true, errorMessage: true },
    })
    const by = (op: string) => calls.filter((c) => c.operation === op)
    const cr = by('createReport'), gr = by('getReport'), doc = by('getReportDocument')
    line()
    line(`${d10(run.startedAt)}  createReport ${cr.length} (ok ${cr.filter((c) => c.success).length}) · getReport ${gr.length} · getReportDocument ${doc.length}`)
    line(`  polls per createReport: ${cr.length ? (gr.length / cr.length).toFixed(1) : '—'} (30 = the ceiling, i.e. the report never finished)`)
    if (cr.length) line(`  createReport latency: p50 ${cr.length ? pctl(cr.map((c) => c.latencyMs), 50) : 0}ms · max ${Math.max(...cr.map((c) => c.latencyMs))}ms`)
    const bad = calls.filter((c) => !c.success)
    if (bad.length) {
      const m = new Map<string, number>()
      for (const c of bad) { const k = `${c.operation} ${c.statusCode ?? '—'} ${String(c.errorMessage ?? '').slice(0, 70)}`; m.set(k, (m.get(k) ?? 0) + 1) }
      for (const [k, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 6)) line(`  ✗ ×${n} ${k}`)
    } else line('  every HTTP call succeeded — the failure is Amazon never finishing the report, not a rejected request')
  }

  // ── the 100-row ceiling ────────────────────────────────────────────────────────────────────
  h('the 100-row reports — a real ceiling, or a coincidence?')
  const hundred = await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, rowCount: 100 } })
  const over = await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, rowCount: { gt: 100 } } })
  const between = await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, rowCount: { gte: 90, lt: 100 } } })
  line(`reports with rowCount exactly 100: ${hundred} · 90-99: ${between} · >100: ${over}`)
  line(over === 0
    ? '🔴 NOTHING has ever exceeded 100 rows ⇒ 100 is a hard per-report ceiling. The biggest ASINs are TRUNCATED,'
    : '✓ reports exceed 100 rows, so 100 is not a ceiling')
  if (over === 0) line('   so widening ASIN coverage adds breadth but the deepest ASINs stay capped at their top 100 queries.')

  // ── what the watchlist actually needs vs what the cron asks for ─────────────────────────────
  h('control — the ledger is populated, so the counts above are measurements')
  line(`AmazonReportRun of type SQP: ${await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE } })}`)
  line(`  with a rowCount recorded: ${await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, rowCount: { not: null } } })}`)
  line(`  DONE: ${await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, status: 'DONE' } })} · FATAL: ${await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, status: 'FATAL' } })}`)
  line(`sqp-ingest CronRun rows: ${await prisma.cronRun.count({ where: { jobName: 'sqp-ingest' } })}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
