/**
 * ACR.2.4 — exactly WHICH ASINs the SQP repair actually covers. READ-ONLY.
 *
 * Test 1 found zero discriminating terms and AIREON on zero terms. Before concluding anything
 * about variation families, establish whether that is a fact about Amazon's SERP or a fact
 * about which rows the backfill repaired.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = <T>(sql: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...a)

console.log('\n══ SQP coverage per week, IT — rows vs ASINs vs MEASURED ASINs ══')
const wks = await q<{ week: string; rows: bigint; asins: bigint; measured_asins: bigint; measured_rows: bigint }>(`
  SELECT "startDate"::text AS week, COUNT(*) AS rows,
         COUNT(DISTINCT asin) AS asins,
         COUNT(DISTINCT asin) FILTER (WHERE "impressionsBrand" > 0) AS measured_asins,
         COUNT(*) FILTER (WHERE "impressionsBrand" > 0) AS measured_rows
  FROM "SearchQueryPerformance" WHERE marketplace='IT' GROUP BY 1 ORDER BY 1 DESC`)
for (const w of wks) console.log(`  ${w.week.slice(0,10)}  rows=${String(w.rows).padStart(5)}  distinct ASINs=${String(w.asins).padStart(3)}  ASINs with our impressions=${String(w.measured_asins).padStart(3)}  (rows ${w.measured_rows})`)

console.log('\n══ The 10 measured ASINs, and their family ══')
const measured = await q<{ asin: string; terms: bigint; impr: bigint; sku: string; parent_name: string }>(`
  SELECT s.asin, COUNT(DISTINCT s."searchQuery") AS terms, SUM(s."impressionsBrand") AS impr,
         COALESCE(MAX(p.sku),'(not in catalogue)') AS sku,
         COALESCE(MAX(par.name), '(no parent)') AS parent_name
  FROM "SearchQueryPerformance" s
  LEFT JOIN "Product" p ON p."amazonAsin" = s.asin AND p."deletedAt" IS NULL
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  WHERE s.marketplace='IT' AND s."impressionsBrand" > 0
  GROUP BY 1 ORDER BY 3 DESC`)
for (const m of measured) console.log(`  ${m.asin}  terms=${String(m.terms).padStart(3)}  impr=${String(m.impr).padStart(6)}  ${String(m.sku).padEnd(22)} ${String(m.parent_name).slice(0,44)}`)

console.log('\n══ ASINs PRESENT in SQP but still unmeasured (impressionsBrand = 0 everywhere) ══')
const unmeasured = await q<{ asin: string; rows: bigint; sku: string; parent_name: string }>(`
  SELECT s.asin, COUNT(*) AS rows,
         COALESCE(MAX(p.sku),'(not in catalogue)') AS sku,
         COALESCE(MAX(par.name),'(no parent)') AS parent_name
  FROM "SearchQueryPerformance" s
  LEFT JOIN "Product" p ON p."amazonAsin" = s.asin AND p."deletedAt" IS NULL
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  WHERE s.marketplace='IT' AND s.asin IS NOT NULL
    AND s.asin NOT IN (SELECT DISTINCT asin FROM "SearchQueryPerformance" WHERE marketplace='IT' AND "impressionsBrand" > 0 AND asin IS NOT NULL)
  GROUP BY 1 ORDER BY 2 DESC LIMIT 30`)
console.log(`  ${unmeasured.length} such ASINs (top 30 by row count):`)
for (const u of unmeasured) console.log(`    ${u.asin}  rows=${String(u.rows).padStart(4)}  ${String(u.sku).padEnd(22)} ${String(u.parent_name).slice(0,44)}`)

console.log('\n══ Is AIREON in SQP at all? ══')
const air = await q<{ asin: string; sku: string; rows: bigint; brand_impr: bigint }>(`
  SELECT p."amazonAsin" AS asin, p.sku, COUNT(s.id) AS rows, COALESCE(SUM(s."impressionsBrand"),0) AS brand_impr
  FROM "Product" p
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  LEFT JOIN "SearchQueryPerformance" s ON s.asin = p."amazonAsin" AND s.marketplace='IT'
  WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL AND par.name ILIKE '%AIREON%'
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 30`)
const withRows = air.filter((a) => Number(a.rows) > 0)
console.log(`  AIREON children: ${air.length} ASINs · ${withRows.length} appear in SQP at all · ${air.filter((a) => Number(a.brand_impr) > 0).length} carry our impressions`)
for (const a of air.slice(0, 12)) console.log(`    ${a.asin}  ${String(a.sku).padEnd(24)} sqpRows=${a.rows} ourImpr=${a.brand_impr}`)

await prisma.$disconnect()
