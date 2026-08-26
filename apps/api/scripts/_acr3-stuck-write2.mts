import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const dupes = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT t.id, t."bidCents", t.status, t."isNegative", c.name AS campaign
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."externalTargetId"='128430480348864'`)
console.log('rows sharing external id 128430480348864:', dupes)
const champ = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT t."bidCents", t."externalTargetId", c.name AS campaign
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE LOWER(t."expressionValue")='giacca moto' AND t."expressionType" IN ('EXACT','_EXACT')
    AND t."isNegative"=false AND t.status='ENABLED' AND c.marketplace='IT'
    AND UPPER(c.name) LIKE '%GALE%' AND c.status='ENABLED'`)
console.log('all enabled GALE IT "giacca moto" EXACT rows:', champ)
await prisma.$disconnect()
