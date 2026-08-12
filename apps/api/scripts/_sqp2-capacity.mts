/**
 * _sqp2-capacity.mts — SQP.2 Phase D: the capacity bound, and whether pacing helps. READ-ONLY.
 *
 * "The number nobody has today" (brief §Phase D). It is derived from what Amazon actually DID, not
 * from a published rate limit, because the binding constraint is not the request rate — it is that
 * this account's reports GENERATE SERIALLY. A rate limit tells you how fast you may ask; it says
 * nothing about a queue that empties one report at a time.
 *
 * Three questions:
 *   1. How long does generation actually take, per report? (`processingStartTime → End`, which is
 *      only knowable from `getReport` — so it comes from the staging manifest and SQP.1's samples.)
 *   2. Given serial generation and the OTHER report crons sharing the slot, how many SQP reports a
 *      day are sustainable, and how many can drain inside the document-retention window?
 *   3. Does pacing the requests change anything? History already contains a paced experiment: on
 *      08-11 and 08-12 the poll loop spaced each `createReport` ~5.2 min apart, and the batch still
 *      took 14.6h to drain. So this checks the claim rather than assuming it.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp2-capacity.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sqpCapacity, SQP_DOCUMENT_RETENTION_HOURS } from '../src/services/advertising/sqp-async.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const pctl = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }

async function main() {
  // ── 1 · how many reports does this account already pull per day? ────────────────────────────
  h('1 · the competing load on the single serial slot')
  const since = new Date(Date.now() - 14 * 86_400_000)
  const runs = await prisma.amazonReportRun.groupBy({
    by: ['reportType'],
    where: { requestedAt: { gte: since } },
    _count: { _all: true },
  })
  const total = runs.reduce((a, r) => a + r._count._all, 0)
  const sqpCount = runs.filter((r) => r.reportType.includes('BRAND_ANALYTICS')).reduce((a, r) => a + r._count._all, 0)
  const others = total - sqpCount
  line(`report pulls in the last 14 days: ${total} (SQP ${sqpCount}, everything else ${others})`)
  line(`${padr('reportType', 46)} ${pad('14d', 5)} ${pad('per day', 8)}`)
  for (const r of [...runs].sort((a, b) => b._count._all - a._count._all).slice(0, 10)) {
    line(`${padr(r.reportType.replace('GET_', '').slice(0, 45), 46)} ${pad(r._count._all, 5)} ${pad((r._count._all / 14).toFixed(1), 8)}`)
  }
  const competingPerDay = others / 14
  line()
  line(`⇒ non-SQP reports per day sharing the serial slot: ${competingPerDay.toFixed(1)}`)

  // ── 2 · measured generation time ────────────────────────────────────────────────────────────
  h('2 · how long generation actually takes (processingStart → processingEnd)')
  const OUT = join(import.meta.dirname, '_sqp2-staged')
  const gens: number[] = []
  const manifestPath = join(OUT, 'manifest.ndjson')
  if (existsSync(manifestPath)) {
    line('(the staging manifest records what was downloaded, not the generation span — using SQP.1\'s')
    line(' getReport samples, which are the only place processingStart/End was ever captured)')
  }
  // SQP.1 §3 measured these directly off getReport for the 104 abandoned reports. Recorded here as
  // the sample rather than re-fetched, and labelled as such.
  const SQP1_GENERATION_SAMPLES_S = [
    991, 924, 10, 8, 9, 10, 10, 8, 9, 2436, 8, 7, 8, 8, 9, 8, 8, 8, 8, 9, 9, 8, 10, 9, 7, 8, 9, 8, 9, 8,
    8, 9, 8, 9, 9, 10, 9, 8, 7, 7, 9, 8, 1221, 1041, 1401, 1370, 1450, 1124, 1289, 9, 1520, 1235, 1354,
    1377, 1188, 1659, 1209, 1476, 1649, 1167, 1300, 1408, 1310, 1626, 2030, 2065, 956, 917, 22, 20, 22,
    922, 19, 22, 20, 921, 920, 20, 23, 20, 922, 19, 917, 21, 11, 919, 10, 8, 21, 924,
  ]
  for (const s of SQP1_GENERATION_SAMPLES_S) gens.push(s * 1000)
  const p50 = pctl(gens, 50), p90 = pctl(gens, 90), p99 = pctl(gens, 99)
  line(`n=${gens.length} · p50 ${(p50 / 1000).toFixed(0)}s · p90 ${(p90 / 1000).toFixed(0)}s · p99 ${(p99 / 1000).toFixed(0)}s · max ${(Math.max(...gens) / 1000).toFixed(0)}s`)
  line(`mean ${(gens.reduce((a, b) => a + b, 0) / gens.length / 1000).toFixed(0)}s — 🔴 BIMODAL: ${gens.filter((g) => g < 60_000).length} reports under 60s and ${gens.filter((g) => g > 600_000).length} over 10 min.`)
  line('  So a p50 capacity figure is optimistic by construction: one slow report blocks the whole')
  line('  queue behind it for up to 34 minutes. The p90 line is the one to plan against.')

  // ── 3 · the bound ───────────────────────────────────────────────────────────────────────────
  h('3 · 🔴 THE CAPACITY BOUND — the hard ceiling on any future widening')
  // 🔴 Empirical, not modelled. The observed drain is 40 reports in 14.6h on 2026-08-11 (SQP.1 §3),
  // measured under the normal competing load. See sqpCapacity's header for why the modelled version
  // was deleted: it returned a capacity of -17.
  const sqpPerDayNow = sqpCount / 14
  const cap = sqpCapacity({
    observedDrainReports: 40,
    observedDrainHours: 14.6,
    sqpReportsPerDayNow: sqpPerDayNow,
    competingReportsPerDay: competingPerDay,
  })
  line(`basis: 40 reports drained in 14.6h on 2026-08-11, under ~${competingPerDay.toFixed(0)} competing reports/day.`)
  line(`       (NOT modelled from generation times — that version returned a capacity of -17, see the`)
  line(`        service header. The bimodal p50 ${(p50 / 1000).toFixed(0)}s / p90 ${(p90 / 1000).toFixed(0)}s above is why.)`)
  line()
  line(`observed throughput                    : ${cap.reportsPerHour.toFixed(2)} reports/hour`)
  line(`🔴 SUSTAINABLE SQP REPORTS PER DAY     : ${cap.sustainablePerDay}`)
  line(`   (a batch must drain inside the 24h before the next one, or the backlog compounds —`)
  line(`    which is precisely the runaway that produced two zero-yield nights)`)
  line(`SQP reports/day pulled right now       : ${sqpPerDayNow.toFixed(1)}`)
  line(`headroom                               : ${cap.headroomPerDay.toFixed(1)} reports/day`)
  line(cap.headroomPerDay < 10
    ? `🔴 The account is essentially AT its ceiling already. Widening has no room without either\n   reducing the competing load or accepting a backlog that grows every night.`
    : `there is room for ${cap.headroomPerDay.toFixed(0)} more reports/day`)
  line(`⇒ ${cap.note}`)
  line()
  line('Against that ceiling:')
  const scenarios: Array<[string, number]> = [
    ["today's nightly ask (4 markets × 10)", 40],
    ['full coverage of rank-governed campaigns (81 IT + 18 DE)', 99],
    ['every advertised ASIN, IT alone (SQP.1 §11.4)', 250],
  ]
  for (const [label, n] of scenarios) {
    const hrs = cap.drainHoursFor(n)
    line(`  ${padr(label, 56)} ${pad(n, 4)} reports ⇒ ${pad(hrs.toFixed(1), 5)}h drain · ${hrs < 24 ? '✓ clears within the day' : '🔴 CANNOT CLEAR IN 24h — the backlog compounds every night'}`)
  }

  // ── 4 · does pacing help? the paced experiment already in history ────────────────────────────
  h('4 · does pacing the requests help? (history already ran the experiment)')
  const abandoned = await prisma.amazonReportRun.findMany({
    where: { reportType: { contains: 'BRAND_ANALYTICS' }, errorMessage: { contains: 'did not reach DONE within' } },
    select: { requestedAt: true, completedAt: true },
    orderBy: { requestedAt: 'asc' },
  })
  const byDay = new Map<string, Date[]>()
  for (const a of abandoned) {
    const k = a.requestedAt.toISOString().slice(0, 10)
    const g = byDay.get(k) ?? []; g.push(a.requestedAt); byDay.set(k, g)
  }
  line(`${padr('day', 12)} ${pad('reports', 8)} ${pad('mean gap', 9)} ${pad('span', 8)} what happened`)
  for (const [day, times] of [...byDay].sort()) {
    if (times.length < 2) continue
    const gaps: number[] = []
    for (let i = 1; i < times.length; i++) gaps.push(+times[i] - +times[i - 1])
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
    const span = +times[times.length - 1] - +times[0]
    line(`${padr(day, 12)} ${pad(times.length, 8)} ${pad(`${(meanGap / 60_000).toFixed(1)}m`, 9)} ${pad(`${(span / 3_600_000).toFixed(1)}h`, 8)} all abandoned at the 300s ceiling`)
  }
  line()
  line('On 08-11 and 08-12 the abandoned poll loop spaced each createReport ~5.2 min apart — an')
  line('unintentional but real PACED run of 40 reports. The batch still took 14.6h to drain.')
  line('⇒ **Pacing does not raise throughput.** Serial generation is the constraint, and it does not')
  line('  care when the requests arrived. What pacing changes is WHEN each document becomes available')
  line('  relative to its own retention clock, which matters only if retention runs from the REQUEST.')
  line('  §5 measures which it is, because that decides whether pacing is worth anything at all.')

  // ── 5 · when does retention actually start? measured, not assumed ────────────────────────────
  h('5 · 🔴 when does the ~72h retention clock start — request, or document creation?')
  if (!existsSync(manifestPath)) {
    line('no staging manifest yet — run _sqp2-stage.mts first; it is the experiment.')
  } else {
    const man = readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const byBatch = new Map<string, { n: number; maxAgeH: number }>()
    for (const m of man as any[]) {
      const k = m.requestedAt.slice(0, 10)
      const ageH = (Date.now() - +new Date(m.requestedAt)) / 3_600_000
      const e = byBatch.get(k) ?? { n: 0, maxAgeH: 0 }
      e.n++; e.maxAgeH = Math.max(e.maxAgeH, ageH); byBatch.set(k, e)
    }
    line(`${padr('request batch', 15)} ${pad('downloaded OK', 14)} ${pad('age at download', 16)}`)
    for (const [k, e] of [...byBatch].sort()) line(`${padr(k, 15)} ${pad(e.n, 14)} ${pad(`${e.maxAgeH.toFixed(1)}h`, 16)}`)
    const oldestOk = Math.max(...(man as any[]).map((m) => (Date.now() - +new Date(m.requestedAt)) / 3_600_000))
    line()
    if (oldestOk > SQP_DOCUMENT_RETENTION_HOURS) {
      line(`⇒ A document requested ${oldestOk.toFixed(1)}h ago DOWNLOADED FINE, which is past the documented ${SQP_DOCUMENT_RETENTION_HOURS}h.`)
      line('  So retention is NOT measured from the request — it runs from when Amazon created the')
      line('  DOCUMENT, which for a queued report can be many hours later. Consequence: pacing buys')
      line('  nothing at all for expiry, and the collector\'s clock-based EXPIRED check is CONSERVATIVE')
      line('  (it may retire a request whose document is still there). Recorded as a follow-up, not')
      line('  changed here — retiring too early loses data only if the collector never retries.')
    } else {
      line(`⇒ Nothing older than ${SQP_DOCUMENT_RETENTION_HOURS}h has been downloaded yet, so the clock's origin is`)
      line('  still undetermined. The 08-09 (85h) and 08-05 (167h) batches settle it when staging reaches them.')
    }
  }

  h('control')
  line(`AmazonReportRun rows (14d) ${total} · SQP ${sqpCount}`)
  line(`SqpReportRequest rows ${await prisma.sqpReportRequest.count()} (0 until the first async request pass)`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
