/**
 * ACR.2.4c — two spot-checks after the crema all-zero result, chosen for maximum
 * information per report rather than blind coverage of the remaining colourway:
 *
 *   B0H8QTNY62 — advertised in all 11 AIREON campaigns, 7.8k impressions/30d, and NOT
 *                in our Product catalogue. If the one visible AIREON child is one we do
 *                not even track, the catalogue-derived widen missed the story.
 *   B0F4NTV47B — NERO-NEO XXL, the other colourway's top impression child (6.5k/30d).
 *                If it is also zero, the colourway does not matter and the remaining
 *                five reports would only confirm what is already measured.
 *
 * Same week as GALE (lookback 2), same ingestSqp upsert path.
 */
import '../src/env.js'

const ASINS = ['B0H8QTNY62', 'B0F4NTV47B']

const { default: prisma } = await import('../src/db.js')
const { periodWindow, ingestSqp } = await import('../src/services/advertising/sqp.service.js')

const w = periodWindow('WEEK', new Date(), 2)
console.log(`spot-check ${ASINS.join(', ')} · week ${w.start.toISOString().slice(0, 10)} → ${w.end.toISOString().slice(0, 10)}`)

const r = await ingestSqp({ marketplaceCode: 'IT', period: 'WEEK', asins: ASINS, startDate: w.start, endDate: w.end })
console.log(`rows=${r.rows} upserted=${r.upserted} failedAsins=${r.failedAsins}`)

const after = await prisma.$queryRawUnsafe<{ asin: string; rows: bigint; impr: bigint }[]>(`
  SELECT asin, COUNT(*) AS rows, COALESCE(SUM("impressionsBrand"),0) AS impr
  FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND "startDate" = $1::date AND asin = ANY($2::text[])
  GROUP BY asin`,
  w.start.toISOString().slice(0, 10), ASINS)
console.log('per-asin:', after.length ? after : 'NO ROWS for either spot-check ASIN')
await prisma.$disconnect()
process.exit(0)
