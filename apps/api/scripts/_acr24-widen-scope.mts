/**
 * ACR.2.4 — which SQP zeros are UNREPAIRED, and which are genuinely zero. READ-ONLY.
 *
 * ACR.2.1 asserted "the residual 1,413 belong to ASINs outside the requested top-10". That is
 * an inference from how the backfill was invoked, not a measurement, and the two cases it
 * conflates are opposite in meaning:
 *
 *   · UNREPAIRED — the row was written by the broken parser and never re-read, so its
 *     `impressionsBrand = 0` means UNMEASURED.
 *   · GENUINELY ZERO — the row WAS re-read by the fixed parser and Amazon reported no brand
 *     impressions for that ASIN on that term. That zero is a fact.
 *
 * `updatedAt` separates them: `ingestSqp` upserts, so any row a backfill touched carries a
 * post-fix timestamp whether or not its value changed. Rows still stamped before the parser fix
 * have never been re-read.
 *
 * The output is the ASIN list a Railway widen must cover, and nothing more.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = <T>(sql: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...a)
const n = (v: unknown) => Number(v ?? 0)

// The repair ran on 2026-08-05; anything stamped before that day has not been re-read.
const CUTOFF = '2026-08-05'

console.log('\n══ When were IT rows last written? ══')
const stamps = await q<{ day: string; rows: bigint; nonzero: bigint; asins: bigint }>(`
  SELECT "updatedAt"::date::text AS day, COUNT(*) AS rows,
         COUNT(*) FILTER (WHERE "impressionsBrand" > 0) AS nonzero,
         COUNT(DISTINCT asin) AS asins
  FROM "SearchQueryPerformance" WHERE marketplace='IT'
  GROUP BY 1 ORDER BY 1 DESC`)
for (const s of stamps) {
  console.log(`  ${s.day}  rows=${String(s.rows).padStart(5)}  with our impressions=${String(s.nonzero).padStart(5)}  ASINs=${s.asins}`)
}

console.log('\n══ Per ASIN: re-read or not ══')
const per = await q<{
  asin: string; sku: string; parent_name: string; rows: bigint
  nonzero: bigint; last_write: string; reread: boolean
}>(`
  SELECT s.asin,
         COALESCE(MAX(p.sku), '(not in catalogue)') AS sku,
         COALESCE(MAX(par.name), '(no parent)') AS parent_name,
         COUNT(*) AS rows,
         COUNT(*) FILTER (WHERE s."impressionsBrand" > 0) AS nonzero,
         MAX(s."updatedAt")::date::text AS last_write,
         (MAX(s."updatedAt") >= $1::date) AS reread
  FROM "SearchQueryPerformance" s
  LEFT JOIN "Product" p ON p."amazonAsin" = s.asin AND p."deletedAt" IS NULL
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  WHERE s.marketplace='IT' AND s.asin IS NOT NULL
  GROUP BY s.asin ORDER BY 7 DESC, 5 DESC`, CUTOFF)

const reread = per.filter((r) => r.reread)
const stale = per.filter((r) => !r.reread)

console.log(`\n  RE-READ since the parser fix — their zeros are FACTS (${reread.length} ASINs):`)
for (const r of reread) {
  const z = n(r.rows) - n(r.nonzero)
  console.log(`    ${r.asin}  ${String(r.sku).padEnd(26)} rows=${String(r.rows).padStart(4)}  nonzero=${String(r.nonzero).padStart(4)}  genuine zeros=${String(z).padStart(4)}  last ${r.last_write}`)
}
console.log(`\n  NEVER re-read — their zeros mean UNMEASURED (${stale.length} ASINs):`)
for (const r of stale) {
  console.log(`    ${r.asin}  ${String(r.sku).padEnd(26)} rows=${String(r.rows).padStart(4)}  last ${r.last_write}  [${String(r.parent_name).slice(0, 34)}]`)
}

const staleRows = stale.reduce((a, r) => a + n(r.rows), 0)
const genuineZeros = reread.reduce((a, r) => a + (n(r.rows) - n(r.nonzero)), 0)
console.log(`\n  → ${staleRows} rows across ${stale.length} ASINs are UNMEASURED (never re-read).`)
console.log(`  → ${genuineZeros} rows across the re-read ASINs are GENUINE zeros — Amazon reported no impressions.`)
console.log(`     ACR.2.1 quoted a residual of 1,413 and attributed all of it to scope; the split above is the measured version.`)

console.log('\n══ Families with NO SQP presence at all (never requested, not even a zero row) ══')
const missing = await q<{ parent_name: string; asins: bigint; in_sqp: bigint }>(`
  SELECT COALESCE(par.name, p.name) AS parent_name,
         COUNT(DISTINCT p."amazonAsin") AS asins,
         COUNT(DISTINCT s.asin) AS in_sqp
  FROM "Product" p
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  LEFT JOIN "SearchQueryPerformance" s ON s.asin = p."amazonAsin" AND s.marketplace='IT'
  WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL
  GROUP BY 1 HAVING COUNT(DISTINCT p."amazonAsin") > 1
  ORDER BY 3 ASC, 2 DESC LIMIT 14`)
for (const m of missing) {
  const flag = n(m.in_sqp) === 0 ? '  ← absent entirely' : ''
  console.log(`  ${String(m.parent_name).slice(0, 46).padEnd(48)} catalogue=${String(m.asins).padStart(3)}  in SQP=${String(m.in_sqp).padStart(3)}${flag}`)
}

console.log('\n══ The widen list ══')
console.log('  A second family on the SAME terms is what the variation experiment needs. Priority:')
console.log('   1. the ASINs above marked "never re-read" — rows already exist, the upsert repairs in place')
console.log('   2. one COMPLETE second family absent entirely (AIREON) — creates the control group')

await prisma.$disconnect()
