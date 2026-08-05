import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const idx = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE tablename = 'AdSchedule' AND indexname LIKE '%campaignId%'`)
console.table(idx)
const applied = idx.some((r) => String(r.indexdef).includes('UNIQUE'))
console.log(applied ? 'UNIQUE constraint is LIVE' : 'NOT applied')
const dropped = !idx.some((r) => r.indexname === 'AdSchedule_campaignId_idx')
console.log(dropped ? 'redundant plain index dropped' : 'plain index still present')
await p.$disconnect()
