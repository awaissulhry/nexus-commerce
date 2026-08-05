/** Why are the last 26 not floored — blocked, pending, or just slow? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)

console.log('campaign gate state:')
console.log(await q(`SELECT name, "liveBidWritesEnabled", status FROM "Campaign" WHERE name='IT_Exact_Gale_SV=2k+_Key=1'`))

console.log('\nrecent AdMutation rows for its targets:')
console.log(await q(`
  SELECT m.state, COUNT(*)::int AS rows, MAX(LEFT(COALESCE(m."lastError",''),80)) AS sample_err
  FROM "AdMutation" m
  WHERE m."createdAt" > now() - interval '2 hours'
    AND m."entityId" IN (
      SELECT t.id FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
      WHERE c.name='IT_Exact_Gale_SV=2k+_Key=1')
  GROUP BY 1`))

console.log('\nbid state now:')
console.log(await q(`
  SELECT COUNT(*)::int AS targets, COUNT(*) FILTER (WHERE t."bidCents" <= 5)::int AS at_floor
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.name='IT_Exact_Gale_SV=2k+_Key=1' AND LOWER(t."expressionValue")='giacca moto'
    AND t."isNegative"=false AND t.status='ENABLED'`))
await p.$disconnect()
