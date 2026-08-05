/**
 * ACR.4 — hasCostPrice must never be true with cogsCents = 0. Repairs 13 stale rows.
 *
 * The ACR.0.5 migration scoped its repair to rows with REVENUE, because a no-revenue row
 * legitimately costs nothing and its profit (the fees it burned) is computable. That was right
 * about the profit and wrong about the FLAG: a row with no cost still has no cost price, whether
 * or not it had revenue. These 13 rows carry costPrice null, weightedAvgCostCents 0 and
 * cogsCents 0, while asserting hasCostPrice = true.
 *
 * They cause no wrong number today — with no revenue they take the fallback path anyway — but
 * the flag is the thing every surface reads to decide whether it may speak confidently, and
 * leaving one that lies is how the next reader is misled.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const before = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*)::int AS lying_rows FROM "ProductProfitDaily"
  WHERE ("coverage"->>'hasCostPrice')::boolean IS TRUE AND "cogsCents" <= 0`)
console.log('\nrows claiming a cost price with cogsCents = 0:', before[0])

const n = await p.$executeRawUnsafe(`
  UPDATE "ProductProfitDaily"
     SET "coverage" = jsonb_set(COALESCE("coverage",'{}'::jsonb), '{hasCostPrice}', 'false'::jsonb)
   WHERE ("coverage"->>'hasCostPrice')::boolean IS TRUE AND "cogsCents" <= 0`)
console.log(`repaired ${n} rows`)

const after = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*) FILTER (WHERE ("coverage"->>'hasCostPrice')::boolean IS TRUE)::int AS real_cost,
         COUNT(*) FILTER (WHERE ("coverage"->>'costEstimated')::boolean IS TRUE)::int AS estimated,
         COUNT(*) FILTER (WHERE "trueProfitCents" IS NOT NULL)::int AS with_profit,
         COUNT(*)::int AS rows
  FROM "ProductProfitDaily"`)
console.log('after:', after[0], '\n')
await p.$disconnect()
