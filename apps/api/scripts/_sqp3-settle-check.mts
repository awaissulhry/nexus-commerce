/** SQP.3 — read-only: does the span guard refuse the week the cycle froze on three minutes' evidence? */
import prisma from '../src/db.js'
import { periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { settledAsins, SQP_SETTLE_MIN_SPAN_HOURS } from '../src/services/advertising/sqp-async.service.js'

const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
const rows = await prisma.sqpReportRequest.findMany({
  where: { reportPeriod: 'WEEK', startDate: win.start, status: 'INGESTED' },
  select: { asin: true, marketplace: true, collectedAt: true, rowsChanged: true }, orderBy: { collectedAt: 'asc' },
})
console.log(`week ${win.start.toISOString().slice(0,10)} · ${rows.length} INGESTED attempts · guard ${SQP_SETTLE_MIN_SPAN_HOURS}h`)
for (const r of rows) console.log(`  ${r.marketplace} ${r.asin}  collected ${r.collectedAt?.toISOString().slice(11,19) ?? '—'}  changed=${r.rowsChanged ?? 'NULL'}`)

const byAsin = new Map<string, Array<{ at: number }>>()
for (const r of rows) if (r.collectedAt) { const l = byAsin.get(r.asin) ?? []; l.push({ at: r.collectedAt.getTime() }); byAsin.set(r.asin, l) }
for (const [asin, l] of byAsin) {
  l.sort((a, b) => a.at - b.at)
  console.log(`  ${asin}: confirmations span ${((l[l.length-1]!.at - l[0]!.at) / 3600_000).toFixed(2)}h`)
}
const withGuard = settledAsins(rows)
const noGuard = settledAsins(rows, 0)
console.log(`\nsettled WITH the ${SQP_SETTLE_MIN_SPAN_HOURS}h guard: ${withGuard.size} ${[...withGuard].join(',') || '(none)'}`)
console.log(`settled with NO guard (what shipped an hour ago): ${noGuard.size} ${[...noGuard].join(',')}`)
console.log(withGuard.size === 0 && noGuard.size > 0
  ? '\n⇒ 🔴 The guard refuses exactly what the burst would have frozen. These weeks will be re-fetched tonight,\n  and can only settle on evidence that spans a night.'
  : '\n⇒ unexpected — inspect before trusting.')
await prisma.$disconnect()
