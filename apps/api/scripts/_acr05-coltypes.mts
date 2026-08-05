import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT column_name, data_type, udt_name FROM information_schema.columns
  WHERE table_name='ProductProfitDaily' AND column_name IN ('coverage','cogsCents','grossRevenueCents')`)
console.log(rows)
const impact = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*)::int AS unknown_cost_rows,
         COUNT(*) FILTER (WHERE "trueProfitCents" <> 0)::int AS currently_claiming_profit
  FROM "ProductProfitDaily" WHERE "cogsCents" <= 0 AND "grossRevenueCents" > 0`)
console.log(impact)
await p.$disconnect()
