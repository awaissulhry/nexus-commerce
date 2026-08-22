import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRawUnsafe<any[]>(`
  SELECT t.status, count(*)::int n
  FROM "AdTarget" t WHERE t.kind='KEYWORD' AND t."isNegative"=false GROUP BY 1 ORDER BY 2 DESC`)
const camp = await prisma.$queryRawUnsafe<any[]>(`
  SELECT c.status AS campaign_status, count(*)::int targets
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t.kind='KEYWORD' AND t."isNegative"=false GROUP BY 1 ORDER BY 2 DESC`)
console.log('===JSON===' + JSON.stringify({ targetStatus: rows, byCampaignStatus: camp }, (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
await prisma.$disconnect()
