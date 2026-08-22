import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<any[]>(`
  SELECT count(*)::int reachable,
         count(*) FILTER (WHERE t."bidCents" BETWEEN 4 AND 4)::int at_4c_would_show_a_RAISE,
         count(*) FILTER (WHERE t."bidCents" >= 5)::int at_5c_plus_would_show_NO_CHANGE,
         count(*) FILTER (WHERE t."bidCents" <= 3)::int suppressed_now_skipped_by_P6
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t.kind='KEYWORD' AND t."isNegative"=false AND t.status='ENABLED' AND c."liveBidWritesEnabled"=true`)
console.log('===JSON===' + JSON.stringify(r[0], (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
await prisma.$disconnect()
