/** SQP.4 — what actually produced the newest week's rows. The natural experiment already ran. */
import prisma from '../src/db.js'
const W = new Date('2026-08-02T00:00:00Z')
for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const rows = await prisma.searchQueryPerformance.groupBy({
    by: ['asin'], where: { reportPeriod: 'WEEK', marketplace: m, startDate: W }, _count: { _all: true },
  })
  const reqs = await prisma.sqpReportRequest.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: W },
    select: { asin: true, rowsParsed: true, requestedAt: true }, orderBy: { requestedAt: 'asc' },
  })
  console.log(`━━━ ${m}: ${rows.reduce((s, r) => s + r._count._all, 0)} rows from ${reqs.length} requests ━━━`)
  for (const r of reqs) {
    // the SQP.3 cycle ran 2026-08-13 21:4x; the nightly pass runs 03:45
    const who = r.requestedAt.toISOString().slice(11, 13) >= '20' ? 'sqp3-cycle (proven ASIN)' : 'nightly pass'
    console.log(`   ${r.asin}  ${String(r.rowsParsed ?? 0).padStart(3)} rows   ${who}`)
  }
  const cycle = reqs.filter((r) => r.requestedAt.toISOString().slice(11, 13) >= '20')
  const night = reqs.filter((r) => r.requestedAt.toISOString().slice(11, 13) < '20')
  const sum = (x: typeof reqs) => x.reduce((s, r) => s + (r.rowsParsed ?? 0), 0)
  if (cycle.length) console.log(`   ⇒ ${cycle.length} hand-picked proven ASINs → ${sum(cycle)} rows (${(sum(cycle)/cycle.length).toFixed(1)}/report)`)
  if (night.length) console.log(`   ⇒ ${night.length} nightly-selected ASINs  → ${sum(night)} rows (${(sum(night)/night.length).toFixed(1)}/report)`)
}
await prisma.$disconnect()
