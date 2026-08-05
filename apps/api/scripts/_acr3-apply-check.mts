import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const r = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*)::int AS mutations,
         COUNT(*) FILTER (WHERE state='APPLIED')::int AS applied,
         COUNT(*) FILTER (WHERE state='PENDING')::int AS pending
  FROM "AdMutation" WHERE "changeSetId" = 'acr3-gale-consolidation-20260805'`)
console.log('mutations:', r[0])
const q = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT "syncStatus", COUNT(*)::int AS rows FROM "OutboundSyncQueue"
  WHERE "syncType"='AD_BID_UPDATE' AND "createdAt" > now() - interval '30 minutes' GROUP BY 1`)
console.log('queue last 30m:', q)
await p.$disconnect()
