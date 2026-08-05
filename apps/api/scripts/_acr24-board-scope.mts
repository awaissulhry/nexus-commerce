/** ACR.2.4b — how much of the advertised catalogue does the coverage board actually measure? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, bigint>[]>(`
  SELECT
    (SELECT COUNT(DISTINCT asin) FROM "SearchQueryPerformance"
      WHERE marketplace='IT' AND "impressionsBrand" > 0) AS sqp_measured_asins,
    (SELECT COUNT(DISTINCT asin) FROM "SearchQueryPerformance"
      WHERE marketplace='IT' AND asin IS NOT NULL) AS sqp_any_row,
    (SELECT COUNT(DISTINCT p."amazonAsin") FROM "Product" p
      WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL) AS catalogue_asins,
    (SELECT COUNT(DISTINCT pa.asin) FROM "AdProductAd" pa
       JOIN "AdGroup" g ON g.id = pa."adGroupId"
       JOIN "Campaign" c ON c.id = g."campaignId"
     WHERE c.marketplace='IT' AND pa.asin IS NOT NULL) AS advertised_asins`)
const x = r[0]!
const n = (k: string) => Number(x[k])
console.log(`\n  catalogue ASINs (live):        ${n('catalogue_asins')}`)
console.log(`  advertised on Amazon IT:       ${n('advertised_asins')}`)
console.log(`  present in SQP at all:         ${n('sqp_any_row')}`)
console.log(`  MEASURED in SQP (impr > 0):    ${n('sqp_measured_asins')}`)
console.log(`\n  → the coverage board's "ours" is ${n('sqp_measured_asins')} of ${n('advertised_asins')} advertised ASINs `
  + `(${((n('sqp_measured_asins') / n('advertised_asins')) * 100).toFixed(1)}%), all one family.`)
console.log(`  → every share on the board therefore UNDERSTATES Xavia by whatever the other families hold.`)
await prisma.$disconnect()
