import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const raw = await prisma.$queryRaw<Array<{e:string|null;n:bigint}>>`SELECT "expressionType"::text e, COUNT(*) n FROM "AdTarget" WHERE "isNegative"=false GROUP BY 1 ORDER BY 2 DESC`
console.log('RAW expressionType spellings (positive targets):')
for (const r of raw) console.log(`   ${JSON.stringify(r.e)}: ${r.n}`)
const ap = await prisma.$queryRaw<Array<{ap:string|null;n:bigint;ags:bigint}>>`
  SELECT c."adProduct"::text ap, COUNT(DISTINCT c.id) n, COUNT(DISTINCT g.id) ags
  FROM "Campaign" c LEFT JOIN "AdGroup" g ON g."campaignId"=c.id GROUP BY 1 ORDER BY 2 DESC`
console.log('\ncampaigns / ad groups by adProduct:')
for (const r of ap) console.log(`   ${r.ap}: ${r.n} campaigns, ${r.ags} ad groups`)
await prisma.$disconnect()
