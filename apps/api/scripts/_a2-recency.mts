import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const r = await p.$queryRawUnsafe(`
  SELECT CASE WHEN "createdAt" > now() - interval '7 days'  THEN 'last_7d'
              WHEN "createdAt" > now() - interval '30 days' THEN 'prior_23d'
              ELSE 'older' END AS age,
         COUNT(*) AS unattributed, MAX("createdAt")::text AS latest
  FROM "AdvertisingActionLog"
  WHERE "userId" IS NULL AND "actionType"='update_placement_bidding'
  GROUP BY 1 ORDER BY 2 DESC`)
console.log(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1))
await p.$disconnect()
