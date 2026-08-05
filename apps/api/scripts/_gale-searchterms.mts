import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const cols = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(`
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name='AmazonAdsSearchTerm' ORDER BY ordinal_position`)
console.log('AmazonAdsSearchTerm columns:', cols.map(c=>c.column_name).join(', '))
const rng = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(`SELECT min(date)::date::text AS oldest, max(date)::date::text AS newest, count(*)::int AS n FROM "AmazonAdsSearchTerm"`)
console.log('range:', JSON.stringify(rng[0]))
await p.$disconnect()
