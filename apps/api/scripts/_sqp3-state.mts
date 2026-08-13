/**
 * _sqp3-state.mts — SQP.3 §7 stop conditions + the state SQP.2 left. READ-ONLY, no Amazon call.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '—')

async function main() {
  h('§7 · STOP CONDITIONS')
  const rt = await prisma.rankTarget.findMany({ select: { key: true, maxBiasPct: true } })
  const set = rt.filter((t) => t.maxBiasPct != null)
  line(`1 · maxBiasPct set on ${set.length} of ${rt.length} — ${set.length === 0 ? '✓ still NULL; the IS branch stays unreachable' : `🔴 SET on ${set.map((t) => t.key).join(',')} — the gate is load-bearing again`}`)
  line(`2 · NEXUS_COVERAGE_ENGINE_MODE = ${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'unset ✓'}`)
  const enabledSets = await prisma.keywordCoverageSet.count({ where: { enabled: true } })
  line(`    KeywordCoverageSet enabled: ${enabledSets} ${enabledSets === 0 ? '✓' : '🔴'}`)

  h('§7 · is anything STUCK in SqpReportRequest?')
  const byStatus = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
  line(`states: ${byStatus.map((b) => `${b.status}=${b._count._all}`).join(' · ') || '(none)'}`)
  const outstanding = await prisma.sqpReportRequest.findMany({
    where: { status: { in: ['PENDING', 'DONE'] } },
    orderBy: { requestedAt: 'asc' },
    select: { reportId: true, marketplace: true, asin: true, status: true, requestedAt: true, pollAttempts: true, lastPolledAt: true, startDate: true },
  })
  line(`outstanding (PENDING|DONE): ${outstanding.length}`)
  for (const o of outstanding.slice(0, 8)) {
    const ageH = (Date.now() - +o.requestedAt) / 3_600_000
    line(`   ${padr(o.marketplace, 4)} ${padr(o.asin, 12)} ${padr(o.status, 8)} age ${pad(ageH.toFixed(1), 6)}h polls ${pad(o.pollAttempts, 4)} lastPoll ${o.lastPolledAt ? `${((Date.now() - +o.lastPolledAt) / 3_600_000).toFixed(1)}h ago` : 'never'}`)
  }
  const oldest = outstanding[0]
  if (oldest) {
    const ageH = (Date.now() - +oldest.requestedAt) / 3_600_000
    line(`⇒ oldest outstanding is ${ageH.toFixed(1)}h old — ${ageH > 72 ? '🔴 past the documented retention; check for a 404' : 'within the documented window'}`)
  }

  h('the collect latency, now that async is live — request → ingest, measured')
  const done = await prisma.sqpReportRequest.findMany({
    where: { status: 'INGESTED', collectedAt: { not: null } },
    select: { requestedAt: true, doneAt: true, collectedAt: true, rowsUpserted: true, marketplace: true },
    orderBy: { collectedAt: 'desc' }, take: 200,
  })
  line(`INGESTED with a collectedAt: ${done.length}`)
  if (done.length) {
    const reqToCollect = done.map((d) => (+d.collectedAt! - +d.requestedAt) / 3_600_000)
    const doneToCollect = done.filter((d) => d.doneAt).map((d) => (+d.collectedAt! - +d.doneAt!) / 3_600_000)
    const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] }
    line(`request → ingest (h): p50 ${pctl(reqToCollect, 50).toFixed(1)} · p90 ${pctl(reqToCollect, 90).toFixed(1)} · max ${Math.max(...reqToCollect).toFixed(1)}`)
    if (doneToCollect.length) line(`🔴 DONE → ingest (h): p50 ${pctl(doneToCollect, 50).toFixed(1)} · p90 ${pctl(doneToCollect, 90).toFixed(1)} · max ${Math.max(...doneToCollect).toFixed(1)}  ← the part a cadence change can fix`)
    else line('no doneAt recorded on any row — the DONE→ingest lag cannot be separated from the queue wait')
    line(`rows upserted by these: ${done.reduce((a, d) => a + (d.rowsUpserted ?? 0), 0)}`)
  }

  h('sqp-collect and sqp-ingest cron history')
  for (const job of ['sqp-ingest', 'sqp-collect']) {
    const runs = await prisma.cronRun.findMany({ where: { jobName: job }, orderBy: { startedAt: 'desc' }, take: 6, select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true } })
    line(`${job}: ${runs.length ? '' : 'no runs'}`)
    for (const r of runs) {
      const dur = r.finishedAt ? ((+r.finishedAt - +r.startedAt) / 1000).toFixed(0) + 's' : 'running'
      line(`   ${r.startedAt.toISOString().slice(5, 16)} ${padr(r.status, 8)} ${pad(dur, 8)} ${(r.outputSummary ?? r.errorMessage ?? '').slice(0, 96)}`)
    }
  }

  h('the stored weeks, and what the page reads')
  const g = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace', 'startDate'], _count: { _all: true } })
  const weeks = [...new Set(g.map((x) => +x.startDate))].sort((a, b) => b - a).slice(0, 6)
  const mkts = ['IT', 'DE', 'ES', 'FR']
  line(`${padr('week', 12)} ${mkts.map((m) => pad(m, 6)).join(' ')} ${pad('total', 7)}`)
  for (const w of weeks) {
    const row = mkts.map((m) => g.find((x) => x.marketplace === m && +x.startDate === w)?._count._all ?? 0)
    line(`${padr(d10(new Date(w)), 12)} ${row.map((n) => pad(n, 6)).join(' ')} ${pad(row.reduce((a, b) => a + b, 0), 7)}`)
  }
  const newest = weeks[0]
  line(`⇒ newest stored week ${d10(new Date(newest))}, ${Math.floor((Date.now() - newest) / 86_400_000)} days old`)

  h('control — a wrong field must THROW')
  try {
    await (prisma.sqpReportRequest as never as { findFirst: (a: unknown) => Promise<unknown> }).findFirst({ select: { revisedAt: true } })
    line('🔴 selected a non-existent column without error')
  } catch (e) { line(`✓ threw: ${String(e).slice(0, 70).replace(/\n/g, ' ')}`) }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
