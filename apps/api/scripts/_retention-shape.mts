import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const q = async (sql: string) => (await p.$queryRawUnsafe<Array<Record<string, unknown>>>(sql))
console.log('OutboundSyncQueue by status:')
console.table(await q(`SELECT "syncStatus" AS status, count(*)::int AS n,
  min("createdAt")::date::text AS oldest,
  count(*) FILTER (WHERE "createdAt" < now() - interval '30 days')::int AS older_than_30d
  FROM "OutboundSyncQueue" GROUP BY 1 ORDER BY 2 DESC`))
console.log('\nAge distribution of the audit tables:')
for (const [t, col] of [['AdvertisingActionLog','createdAt'],['CampaignBidHistory','changedAt'],['AdMutation','createdAt']] as const) {
  const r = await q(`SELECT
    count(*) FILTER (WHERE "${col}" > now() - interval '30 days')::int AS d30,
    count(*) FILTER (WHERE "${col}" > now() - interval '90 days')::int AS d90,
    count(*)::int AS total FROM "${t}"`)
  console.log(`  ${t.padEnd(22)} last30d=${String(r[0].d30).padStart(6)}  last90d=${String(r[0].d90).padStart(6)}  total=${String(r[0].total).padStart(6)}`)
}
await p.$disconnect()
