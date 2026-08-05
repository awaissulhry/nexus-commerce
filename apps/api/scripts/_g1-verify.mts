import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const t = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(`
  SELECT to_regclass('public."RankScheduleEvent"')::text AS tbl`)
console.log('RankScheduleEvent table:', t[0].tbl ?? 'NOT PRESENT')
if (t[0].tbl) {
  const idx = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(`
    SELECT indexname FROM pg_indexes WHERE tablename='RankScheduleEvent'`)
  console.log('indexes:', idx.map(i=>i.indexname).join(', '))
  console.log('rows:', await p.rankScheduleEvent.count(), '(0 expected — inert until one is authored)')
}
await p.$disconnect()
