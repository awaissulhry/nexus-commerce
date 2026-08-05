import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now() - 30*24*3600*1000)
const g = await p.amazonAdsDailyPerformance.groupBy({ by:['entityType'], where:{date:{gte:since}}, _count:true })
console.log('AmazonAdsDailyPerformance, last 30d, by entityType:')
for (const r of g.sort((a,b)=>b._count-a._count)) console.log(`  ${String(r._count).padStart(7)}  ${r.entityType}`)
// is there a search-term table at all?
const st = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(`
  SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables
  WHERE relname ILIKE '%searchterm%' OR relname ILIKE '%search_term%' OR relname ILIKE '%sqp%' ORDER BY n_live_tup DESC LIMIT 8`)
console.log('\nsearch-term / SQP tables:'); console.table(st)
await p.$disconnect()
