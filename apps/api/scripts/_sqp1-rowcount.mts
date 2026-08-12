/**
 * _sqp1-rowcount.mts — SQP.1 Phase A, two corrections to my own earlier numbers.
 *
 * 🔴 READ-ONLY. No Amazon call, no write.
 *
 * 1. `_sqp1-diagnose.mts` reported "1549 DONE reports came back EMPTY" by bucketing
 *    `(rowCount ?? 0) === 0`. That is the null-read-as-zero trap: AmazonReportRun.rowCount is
 *    filled by `deriveRowCount`, a GENERIC helper that takes the longest TOP-LEVEL array of the
 *    payload and returns **null** when there isn't one. The 2026-08-03 run proves the two are
 *    different: 40 DONE reports, every rowCount blank, and the run still upserted 210 rows.
 *    So this splits null from 0 and checks each against what the run actually wrote.
 *
 * 2. Whether Amazon's report GENERATION time drifted upward into our 300s client ceiling, or
 *    whether the ceiling was always marginal — measured per day off DONE reports only, because
 *    a timed-out report's wall time is our ceiling, not Amazon's latency, and mixing the two
 *    would manufacture the very trend it claims to find.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp1-rowcount.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { SQP_REPORT_TYPE } from '../src/services/advertising/sqp.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const pctl = (xs: number[], p: number) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function main() {
  h('1 · rowCount: null is NOT zero. What does each value mean?')
  const all = await prisma.amazonReportRun.findMany({
    where: { reportType: SQP_REPORT_TYPE },
    select: { status: true, rowCount: true, requestedAt: true, completedAt: true, dataStartTime: true, marketplace: true, errorMessage: true },
    orderBy: { requestedAt: 'desc' },
  })
  const done = all.filter((r) => r.status === 'DONE')
  const nul = done.filter((r) => r.rowCount == null)
  const zero = done.filter((r) => r.rowCount === 0)
  const pos = done.filter((r) => (r.rowCount ?? 0) > 0)
  line(`SQP report attempts (ALL, no take cap): ${all.length}`)
  line(`  DONE ${done.length} → rowCount null ${nul.length} · rowCount 0 ${zero.length} · rowCount >0 ${pos.length}`)
  line(`  not DONE ${all.length - done.length}`)
  line()
  line('⇒ CORRECTION to _sqp1-diagnose.mts: it said "1549 DONE reports came back EMPTY".')
  line(`  The truthful split is ${zero.length} genuinely-zero and ${nul.length} UNKNOWN (rowCount never derived).`)
  line('  deriveRowCount returns null for an object payload with no top-level array, so a null here')
  line('  says "this ledger cannot see into the payload", not "Amazon sent nothing".')

  h('2 · the proof that null ≠ empty — rowCount vs what the run WROTE, per run')
  const runs = await prisma.cronRun.findMany({
    where: { jobName: 'sqp-ingest', finishedAt: { not: null } },
    select: { startedAt: true, finishedAt: true, outputSummary: true },
    orderBy: { startedAt: 'desc' },
    take: 14,
  })
  line(`${padr('run', 12)} ${pad('att', 4)} ${pad('DONE', 5)} ${pad('null', 5)} ${pad('zero', 5)} ${pad('>0', 4)} ${pad('ledger-rows', 12)}  cron summary`)
  for (const run of runs) {
    const rs = all.filter((r) => +r.requestedAt >= +run.startedAt && +r.requestedAt <= +run.finishedAt!)
    const d = rs.filter((r) => r.status === 'DONE')
    const upserted = Number(/rows=(\d+)/.exec(run.outputSummary ?? '')?.[1] ?? NaN)
    const ledger = d.reduce((a, r) => a + (r.rowCount ?? 0), 0)
    const flag = Number.isNaN(upserted) ? '' : (ledger === 0 && upserted > 0 ? '  🔴 ledger says 0, the run wrote ' + upserted : (ledger !== upserted ? `  ⚠ ledger ${ledger} ≠ written ${upserted}` : '  ✓ agree'))
    line(`${padr(d10(run.startedAt), 12)} ${pad(rs.length, 4)} ${pad(d.length, 5)} ${pad(d.filter((r) => r.rowCount == null).length, 5)} ${pad(d.filter((r) => r.rowCount === 0).length, 5)} ${pad(d.filter((r) => (r.rowCount ?? 0) > 0).length, 4)} ${pad(ledger, 12)}  ${padr(run.outputSummary ?? '', 32)}${flag}`)
  }
  line()
  line('⇒ Where the ledger and the run disagree, the RUN is right: parseSqp reads the payload,')
  line('  deriveRowCount only guesses at its shape. Use status+errorMessage from this ledger, never rowCount.')

  h('3 · did Amazon get slower, or was the 300s ceiling always marginal?')
  line('DONE reports only — a timed-out report measures OUR ceiling, not Amazon\'s generation time.')
  line(`${padr('day', 12)} ${pad('DONE', 5)} ${pad('p50s', 6)} ${pad('p90s', 6)} ${pad('max s', 6)} ${pad('≥250s', 6)}  window requested`)
  const byDay = new Map<string, typeof all>()
  for (const r of all) {
    if (!r.completedAt) continue
    const k = d10(r.requestedAt)
    const g = byDay.get(k) ?? []; g.push(r); byDay.set(k, g as any)
  }
  for (const [day, g] of [...byDay].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 18)) {
    const dn = g.filter((r) => r.status === 'DONE')
    const lat = dn.map((r) => (+r.completedAt! - +r.requestedAt) / 1000)
    const wins = [...new Set(g.map((r) => d10(r.dataStartTime)))].sort().join(',')
    line(`${padr(day, 12)} ${pad(dn.length, 5)} ${pad(lat.length ? pctl(lat, 50)!.toFixed(0) : '—', 6)} ${pad(lat.length ? pctl(lat, 90)!.toFixed(0) : '—', 6)} ${pad(lat.length ? Math.max(...lat).toFixed(0) : '—', 6)} ${pad(lat.filter((x) => x >= 250).length, 6)}  ${wins}`)
  }
  line()
  line('The client gives up at 30 polls × 10s = 300s (plus the createReport round trip).')
  const doneLat = done.filter((r) => r.completedAt).map((r) => (+r.completedAt! - +r.requestedAt) / 1000)
  line(`Across every DONE report ever: p50 ${pctl(doneLat, 50)?.toFixed(0)}s · p90 ${pctl(doneLat, 90)?.toFixed(0)}s · p99 ${pctl(doneLat, 99)?.toFixed(0)}s · max ${Math.max(...doneLat).toFixed(0)}s`)
  line(`Reports that finished but needed >250s (i.e. within 50s of the ceiling): ${doneLat.filter((x) => x > 250).length} of ${doneLat.length}`)
  line(`Reports that finished and needed >300s (the ceiling is not a hard wall — createReport time is extra): ${doneLat.filter((x) => x > 300).length}`)

  h('4 · the abandoned reports — what we threw away')
  const abandoned = all.filter((r) => /did not reach DONE within/.test(r.errorMessage ?? ''))
  line(`reports abandoned at the poll ceiling, all time: ${abandoned.length}`)
  const byDayAb = new Map<string, number>()
  for (const r of abandoned) byDayAb.set(d10(r.requestedAt), (byDayAb.get(d10(r.requestedAt)) ?? 0) + 1)
  line(`by day: ${[...byDayAb].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12).map(([k, v]) => `${k}→${v}`).join(' · ')}`)
  line()
  line('Each of these has a real Amazon reportId that we stopped polling. The code creates a NEW')
  line('report next run rather than resuming the old one, so an in-flight report is never collected —')
  line('and the reportId, which IS recorded here, is the thing a resume would need.')
  const withId = await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, errorMessage: { contains: 'did not reach DONE within' }, reportId: { not: null } } })
  line(`abandoned reports whose reportId we still hold: ${withId} of ${abandoned.length}`)

  h('control')
  line(`AmazonReportRun SQP total ${all.length} · DONE ${done.length} · with completedAt ${all.filter((r) => r.completedAt).length}`)
  line(`sqp-ingest CronRun rows ${await prisma.cronRun.count({ where: { jobName: 'sqp-ingest' } })}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
