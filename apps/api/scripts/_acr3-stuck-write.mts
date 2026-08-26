import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const t = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT t.id, t."bidCents", t."externalTargetId" FROM "AdTarget" t
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.name='IT_Exact_Gale_SV=2k+_Key=1' AND LOWER(t."expressionValue")='giacca moto'
    AND t."isNegative"=false AND t.status='ENABLED' AND t."externalTargetId" IS NOT NULL`)
console.log('target:', t)
if (t[0]) {
  const m = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
    SELECT id, state, attempts, "updatedAt"::text AS updated, LEFT(COALESCE("lastError",''),80) AS err, "outboundQueueId"
    FROM "AdMutation" WHERE "entityId" = '${t[0].id}' ORDER BY "createdAt" DESC LIMIT 5`)
  console.log('mutations:', m)
  const q = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
    SELECT id, "syncStatus", "retryCount", "updatedAt"::text AS updated, LEFT(COALESCE("errorMessage",''),80) AS err
    FROM "OutboundSyncQueue" WHERE id IN (SELECT "outboundQueueId" FROM "AdMutation" WHERE "entityId"='${t[0].id}' AND "outboundQueueId" IS NOT NULL)
    ORDER BY "createdAt" DESC LIMIT 5`)
  console.log('queue:', q)
}
await p.$disconnect()
