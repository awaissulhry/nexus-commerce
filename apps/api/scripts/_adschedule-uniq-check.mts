import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const dupes = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "campaignId", count(*)::int AS n FROM "AdSchedule" GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC`)
const total = await p.adSchedule.count()
console.log(`AdSchedule rows: ${total}`)
console.log(`campaignId duplicates: ${dupes.length}`)
if (dupes.length) console.table(dupes)
// Would the constraint also forbid something the product legitimately does today?
const modes = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT (CASE WHEN "defaultTargetKey" IS NOT NULL THEN 'goal' ELSE 'classic/other' END) AS mode,
         count(*)::int AS n FROM "AdSchedule" GROUP BY 1`)
console.log('\nmode split (a unique index forbids one campaign holding BOTH):')
console.table(modes)
console.log(dupes.length === 0 ? '\nSAFE TO APPLY' : '\nDO NOT APPLY — resolve duplicates first')
await p.$disconnect()
