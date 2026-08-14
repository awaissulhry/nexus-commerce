/**
 * SQP.4 — per-report yield from OUR OWN ledger, and the real sustainable rate (§6.1).
 *
 * §8 says SqpReportRequest carries no readable per-report row count. It does: SQP.2 added
 * `rowsParsed`/`rowsUpserted` and SQP.3 added `rowsChanged`. So the yield curve IS re-derivable from
 * the ledger, without calling Amazon at all.
 */
import prisma from '../src/db.js'
const reqs = await prisma.sqpReportRequest.findMany({
  select: { marketplace: true, asin: true, startDate: true, status: true, rowsParsed: true, rowsUpserted: true,
            rowsChanged: true, requestedAt: true, collectedAt: true, doneAt: true },
  orderBy: { requestedAt: 'asc' },
})
console.log(`━━━ ${reqs.length} requests in the ledger ━━━`)
console.log(`  rowsParsed non-null: ${reqs.filter((r) => r.rowsParsed !== null).length} · rowsUpserted: ${reqs.filter((r) => r.rowsUpserted !== null).length} · rowsChanged: ${reqs.filter((r) => r.rowsChanged !== null).length}`)

console.log('\n━━━ yield per report, from the ledger ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const byM = new Map<string, { n: number; rows: number; empty: number }>()
for (const r of reqs) {
  if (r.rowsParsed === null) continue
  const c = byM.get(r.marketplace) ?? { n: 0, rows: 0, empty: 0 }
  c.n++; c.rows += r.rowsParsed; if (r.rowsParsed === 0) c.empty++
  byM.set(r.marketplace, c)
}
console.log('mkt  reports   rows   rows/report   empty%')
for (const [m, c] of [...byM].sort((a, b) => b[1].rows / b[1].n - a[1].rows / a[1].n))
  console.log(`${m.padEnd(4)} ${String(c.n).padStart(7)} ${String(c.rows).padStart(6)}   ${(c.rows / c.n).toFixed(2).padStart(11)}   ${((100 * c.empty) / c.n).toFixed(0).padStart(5)}%`)

console.log('\n━━━ the real sustainable rate (§6.1) — divide by the age of the THING ━━━')
const first = reqs[0]!.requestedAt, last = reqs[reqs.length - 1]!.requestedAt
const ledgerAgeH = (Date.now() - +first) / 3600_000
console.log(`  ledger spans ${first.toISOString().slice(5, 16)} → ${last.toISOString().slice(5, 16)} = ${(ledgerAgeH / 24).toFixed(2)} days`)
console.log(`  requests: ${reqs.length} ⇒ ${(reqs.length / (ledgerAgeH / 24)).toFixed(1)}/day observed (consumption, NOT capacity)`)

// drain rate per nightly batch: requestedAt cluster -> last collectedAt
const batches = new Map<string, { n: number; first: number; lastDone: number }>()
for (const r of reqs) {
  const k = r.requestedAt.toISOString().slice(0, 10)
  const b = batches.get(k) ?? { n: 0, first: +r.requestedAt, lastDone: 0 }
  b.n++; b.first = Math.min(b.first, +r.requestedAt)
  if (r.collectedAt) b.lastDone = Math.max(b.lastDone, +r.collectedAt)
  batches.set(k, b)
}
console.log('\n  batch      reports   drain h   reports/h (drain)')
for (const [d, b] of [...batches].sort()) {
  if (!b.lastDone || b.n < 3) continue
  const h = (b.lastDone - b.first) / 3600_000
  console.log(`  ${d}  ${String(b.n).padStart(7)}   ${h.toFixed(2).padStart(7)}   ${(b.n / Math.max(h, 0.01)).toFixed(1).padStart(8)}`)
}
console.log('\n  🔴 drain h includes the hourly collect tick, so reports/h is a LOWER bound on generation.')

console.log('\n━━━ document retention actually observed (§6.3) ━━━━━━━━━━━━━━━━━━━━━━━━━')
const withBoth = reqs.filter((r) => r.collectedAt && r.doneAt)
const ages = withBoth.map((r) => (+r.collectedAt! - +r.doneAt!) / 3600_000).sort((a, b) => b - a)
console.log(`  ${withBoth.length} requests have both doneAt and collectedAt`)
console.log(`  oldest document successfully downloaded: ${ages[0]?.toFixed(1) ?? '—'}h after Amazon finished it`)
console.log(`  p50 ${ages[Math.floor(ages.length / 2)]?.toFixed(2) ?? '—'}h · any 404s would appear as status != INGESTED (none: all ${reqs.length} INGESTED)`)
await prisma.$disconnect()
