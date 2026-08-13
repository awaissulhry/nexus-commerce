/**
 * _sqp3-throughput.mts — 🔴 SQP.3: is SQP.2's "2.74 reports/hour" a constant, or was it one bad night?
 *
 * SQP.2 derived 65 reports/day from a single observation: 40 reports draining in 14.6 h on 2026-08-11.
 * Today's experiments drained 7 Brand Analytics reports in minutes. If the throughput varies by an
 * order of magnitude, a capacity ceiling derived from one night is not a ceiling. READ-ONLY.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const d10 = (d: Date) => d.toISOString().slice(0, 10)

async function main() {
  h("today's Brand Analytics reports, from SqpReportRequest — request → done")
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const reqs = await prisma.sqpReportRequest.findMany({
    where: { requestedAt: { gte: today } },
    select: { requestedAt: true, doneAt: true, collectedAt: true, rowsUpserted: true, asin: true, marketplace: true },
    orderBy: { requestedAt: 'asc' },
  })
  line(`requests today: ${reqs.length}`)
  if (reqs.length >= 2) {
    const first = +reqs[0].requestedAt
    const lastDone = Math.max(...reqs.filter((r) => r.doneAt).map((r) => +r.doneAt!))
    const drainH = (lastDone - first) / 3_600_000
    line(`first requested ${reqs[0].requestedAt.toISOString().slice(11, 19)} · last DONE ${new Date(lastDone).toISOString().slice(11, 19)}`)
    line(`⇒ ${reqs.length} reports drained in ${drainH.toFixed(2)}h = ${(reqs.length / drainH).toFixed(1)} reports/hour`)
  }

  h('the same figure, per ingest day, over the whole history')
  const all = await prisma.sqpReportRequest.findMany({
    where: { doneAt: { not: null } },
    select: { requestedAt: true, doneAt: true },
    orderBy: { requestedAt: 'asc' },
  })
  const byDay = new Map<string, Array<{ req: number; done: number }>>()
  for (const r of all) {
    const k = d10(r.requestedAt)
    const a = byDay.get(k) ?? []; a.push({ req: +r.requestedAt, done: +r.doneAt! }); byDay.set(k, a)
  }
  line(`${padr('day', 12)} ${pad('reports', 8)} ${pad('drain h', 9)} ${pad('per hour', 9)}`)
  for (const [k, v] of [...byDay].sort()) {
    const drainH = (Math.max(...v.map((x) => x.done)) - Math.min(...v.map((x) => x.req))) / 3_600_000
    line(`${padr(k, 12)} ${pad(v.length, 8)} ${pad(drainH.toFixed(2), 9)} ${pad(drainH > 0 ? (v.length / drainH).toFixed(1) : '∞', 9)}`)
  }
  line()
  line("SQP.2's basis, for comparison: 40 reports in 14.6h = 2.74/hour → 65/day.")
  line('🔴 If the rows above differ from that by an order of magnitude, 65/day is not a ceiling —')
  line('   it is a measurement of one congested night, and a widening plan sized to it is sized wrong')
  line('   in whichever direction the next night happens to fall.')

  h('does any campaign READ a parser-bug week? (the 3,700 rows)')
  // sqpImpressionShareForAsins takes the LATEST week for the ASIN set, with no date floor. So an ASIN
  // whose only stored weeks are pre-fix ones reads a share of exactly 0.
  const rows = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace', 'asin'], _max: { startDate: true },
  })
  const brokenWeeks = new Set(['2026-06-07', '2026-05-31', '2026-05-24', '2026-05-17'])
  const stuck = rows.filter((r) => r.asin && r._max.startDate && brokenWeeks.has(d10(r._max.startDate)))
  line(`(market, asin) pairs whose NEWEST stored week is a 100%-broken one: ${stuck.length} of ${rows.length}`)
  for (const s of stuck.slice(0, 10)) line(`   ${s.marketplace} ${s.asin} — newest ${d10(s._max.startDate!)}`)
  line()
  line(stuck.length === 0
    ? '✓ NONE. Every ASIN has a post-fix week that is newer, so sqpImpressionShareForAsins never reads a\n  broken row, and the KT page\'s 42-day window excludes them entirely. The 3,700 rows are wrong and\n  invisible — a data-quality debt, not a live defect.'
    : `🔴 ${stuck.length} pairs would read a share of exactly 0 from a row that was never really zero.`)

  h('control')
  line(`SqpReportRequest ${await prisma.sqpReportRequest.count()} · SearchQueryPerformance ${await prisma.searchQueryPerformance.count()}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
