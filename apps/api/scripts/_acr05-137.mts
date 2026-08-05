import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
console.log(await p.$queryRawUnsafe(`
  SELECT COUNT(*)::int AS known_rows,
         COUNT(*) FILTER (WHERE "grossRevenueCents" = 0)::int AS zero_revenue,
         COUNT(*) FILTER (WHERE "grossRevenueCents" > 0 AND "cogsCents" > 0)::int AS real_cost,
         COUNT(*) FILTER (WHERE "trueProfitCents" < 0)::int AS negative_profit,
         MIN("trueProfitCents")::int AS min_profit, MAX("trueProfitCents")::int AS max_profit
  FROM "ProductProfitDaily" WHERE "trueProfitCents" IS NOT NULL`))
await p.$disconnect()
