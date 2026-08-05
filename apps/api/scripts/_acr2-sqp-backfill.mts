/**
 * ACR.2.1 — re-ingest the SQP weeks the broken parser zeroed.
 *
 * The parser fix (2026-08-05) was FORWARD-ONLY: nothing re-reads an already-ingested report, so
 * all 9,278 stored rows still carry `impressionsBrand = 0` and the coverage baseline the whole
 * program needs is unusable. Amazon still publishes those weeks, and `ingestSqp` upserts on
 * (marketplace, period, startDate, searchQuery, asin) — so re-reading a past week REPAIRS the
 * stored rows rather than duplicating them.
 *
 * Two things this must not get wrong, both learned the hard way on 2026-08-05:
 *   · `dataEndTime` must land on a SATURDAY for reportPeriod=WEEK.
 *   · lookback must be >= 2 — one week back is not published and Amazon answers with a
 *     generic client error.
 * Both are handled by the service's own `periodWindow()`, so the weeks are derived from it
 * rather than hand-rolled. Hand-rolling those dates is exactly what produced both failures.
 *
 * ASINs are passed EXPLICITLY, taken from what is already stored for the marketplace, so the
 * upsert lands on the existing rows. Letting the service pick its own top-N would write a
 * correct-but-different set and leave the zeroed rows in place beside them.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr2-sqp-backfill.mts [market=IT] [weeks=4] [asinLimit=10] [--dry]
 */
import '../src/env.js'

const MARKET = (process.argv[2] ?? 'IT').toUpperCase()
const WEEKS = Math.max(1, Math.min(10, Number(process.argv[3] ?? 4)))
const ASIN_LIMIT = Math.max(1, Math.min(50, Number(process.argv[4] ?? 10)))
// Where to start counting back. 2 is the newest PUBLISHED week; raise it to resume a backfill
// without re-requesting weeks already repaired — each one costs ~6 minutes of report generation.
const FROM = Math.max(2, Number(process.argv[5] ?? 2))
const DRY = process.argv.includes('--dry')

const { default: prisma } = await import('../src/db.js')
const { periodWindow, ingestSqp } = await import('../src/services/advertising/sqp.service.js')

const stored = await prisma.searchQueryPerformance.groupBy({
  by: ['asin'],
  where: { marketplace: MARKET },
  _count: { _all: true },
  orderBy: { _count: { asin: 'desc' } },
})
// Most-covered ASINs first: they carry the head terms, and each extra ASIN is another report.
const asins = stored.map((r) => r.asin).slice(0, ASIN_LIMIT)

const weeks = Array.from({ length: WEEKS }, (_, i) => periodWindow('WEEK', new Date(), i + FROM))

console.log(`\nMarket ${MARKET} · ${asins.length} ASINs · ${weeks.length} weeks · ${DRY ? 'DRY RUN' : 'LIVE'}`)
console.log(`ASINs: ${asins.join(', ')}`)
for (const w of weeks) {
  console.log(`  week ${w.start.toISOString().slice(0, 10)} → ${w.end.toISOString().slice(0, 10)} (end is a ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][w.end.getUTCDay()]})`)
}
console.log(`\n${asins.length * weeks.length} reports to request.\n`)

if (DRY) {
  await prisma.$disconnect()
  console.log('Dry run — nothing requested, nothing written.\n')
  process.exit(0)
}

let okWeeks = 0
for (const w of weeks) {
  const label = w.start.toISOString().slice(0, 10)
  try {
    const r = await ingestSqp({ marketplaceCode: MARKET, period: 'WEEK', asins, startDate: w.start, endDate: w.end })
    const after = await prisma.searchQueryPerformance.count({
      where: { marketplace: MARKET, startDate: new Date(`${label}T00:00:00.000Z`), impressionsBrand: { gt: 0 } },
    })
    console.log(`  ${label}  rows=${r.rows} upserted=${r.upserted} failedAsins=${r.failedAsins}  → ${after} rows now carry our impressions`)
    okWeeks += 1
  } catch (err) {
    console.error(`  ${label}  FAILED: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const total = await prisma.searchQueryPerformance.aggregate({
  where: { marketplace: MARKET },
  _count: { _all: true },
})
const repaired = await prisma.searchQueryPerformance.count({ where: { marketplace: MARKET, impressionsBrand: { gt: 0 } } })
console.log(`\n${okWeeks}/${weeks.length} weeks ingested. ${MARKET}: ${repaired} of ${total._count._all} rows now carry our own impressions.\n`)
await prisma.$disconnect()
