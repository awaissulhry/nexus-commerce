import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<any[]>(`
  SELECT c."adProduct" AS prod, t."negativeLevel" AS lvl, t.status, COUNT(*)::int AS n
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."isNegative"=true GROUP BY 1,2,3 ORDER BY 1,2,3`)
for (const r of rows) console.log(`  ${r.prod}  level=${r.lvl}  ${r.status}  → ${r.n}`)
await p.$disconnect(); process.exit(0)
