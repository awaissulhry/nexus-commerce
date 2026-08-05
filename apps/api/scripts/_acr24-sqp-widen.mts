/**
 * ACR.2.4 — widen the SQP ASIN set so the variation question is answerable at all.
 *
 * The ACR.2.1 backfill took its ASINs from what was ALREADY STORED (`_acr2-sqp-backfill.mts`
 * line 43), and only the top 10 by row count. Measured today: all 10 belong to ONE parent —
 * XAVIA GALE — and AIREON, the unified parent the experiment exists to judge, has **zero rows
 * in SearchQueryPerformance**. A backfill seeded from stored rows can never reach it: an ASIN
 * with no rows can never be in the top 10 of rows.
 *
 * So ASINs are resolved from the CATALOGUE by family, not from SQP. One report per ASIN, the
 * same `ingestSqp` upsert path ACR.2.1 used — it creates the missing rows and repairs existing
 * ones in place on (marketplace, period, startDate, searchQuery, asin).
 *
 * Usage: npx tsx scripts/_acr24-sqp-widen.mts <namePattern> [lookbackWeeks=2] [max=14] [--dry]
 *   lookback 2 == the week of 2026-07-19 when run on 2026-08-05 — the same week GALE is
 *   measured on, so the two families are directly comparable.
 */
import '../src/env.js'

const PATTERN = process.argv[2] ?? 'AIREON'
const LOOKBACK = Math.max(2, Number(process.argv[3] ?? 2) || 2)
const MAX = Math.max(1, Math.min(30, Number(process.argv[4] ?? 14) || 14))
const DRY = process.argv.includes('--dry')

const { default: prisma } = await import('../src/db.js')
const { periodWindow, ingestSqp } = await import('../src/services/advertising/sqp.service.js')

const rows = await prisma.$queryRawUnsafe<{ asin: string; sku: string; parent_name: string }[]>(`
  SELECT p."amazonAsin" AS asin, p.sku, COALESCE(par.name, p.name) AS parent_name
  FROM "Product" p
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL
    AND (par.name ILIKE $1 OR p.name ILIKE $1 OR p.sku ILIKE $1)
  GROUP BY 1, 2, 3
  ORDER BY p.sku`, `%${PATTERN}%`)

// Jackets before trousers: the coverage question is about `giacca moto` terms, and each ASIN
// costs its own report.
const ranked = [...rows].sort((a, b) => {
  const j = (s: string) => (/JACKET|GIACCA/i.test(s) ? 0 : 1)
  return j(a.sku ?? '') - j(b.sku ?? '')
})
const asins = ranked.slice(0, MAX).map((r) => r.asin)
const w = periodWindow('WEEK', new Date(), LOOKBACK)
const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w.end.getUTCDay()]

console.log(`\n${PATTERN}: ${rows.length} catalogue ASINs · requesting ${asins.length} · ${DRY ? 'DRY RUN' : 'LIVE'}`)
console.log(`week ${w.start.toISOString().slice(0, 10)} → ${w.end.toISOString().slice(0, 10)} (end is a ${dow} — must be Saturday)`)
for (const r of ranked.slice(0, MAX)) console.log(`  ${r.asin}  ${r.sku}`)

if (DRY) { await prisma.$disconnect(); console.log('\nDry run — nothing requested, nothing written.\n'); process.exit(0) }

const t0 = Date.now()
const r = await ingestSqp({ marketplaceCode: 'IT', period: 'WEEK', asins, startDate: w.start, endDate: w.end })
console.log(`\nrows=${r.rows} upserted=${r.upserted} failedAsins=${r.failedAsins} in ${Math.round((Date.now() - t0) / 1000)}s`)

const after = await prisma.$queryRawUnsafe<{ asins: bigint; rows: bigint; impr: bigint }[]>(`
  SELECT COUNT(DISTINCT asin) AS asins, COUNT(*) AS rows, COALESCE(SUM("impressionsBrand"),0) AS impr
  FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND "startDate" = $1::date AND asin = ANY($2::text[]) AND "impressionsBrand" > 0`,
  w.start.toISOString().slice(0, 10), asins)
console.log(`${PATTERN} now measured: ${after[0]?.asins} ASINs · ${after[0]?.rows} rows · ${after[0]?.impr} impressions\n`)
await prisma.$disconnect()
