import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT relname AS table,
         to_char(n_live_tup, 'FM999,999,999') AS approx_rows,
         pg_size_pretty(pg_total_relation_size(relid)) AS total_size
  FROM pg_stat_user_tables
  WHERE relname IN ('CampaignBidHistory','AdvertisingActionLog','AdMutation','AmazonAdsHourlyPerformance','AmazonAdsDailyPerformance','RankScheduleVersion','AdDrift','OutboundSyncQueue')
  ORDER BY pg_total_relation_size(relid) DESC`)
console.table(rows)
for (const [label, q] of [
  ['CampaignBidHistory', 'SELECT min("changedAt")::date::text AS oldest, count(*)::int AS n, count(*) FILTER (WHERE "changedAt" > now() - interval \'7 days\')::int AS last7 FROM "CampaignBidHistory"'],
  ['AdvertisingActionLog', 'SELECT min("createdAt")::date::text AS oldest, count(*)::int AS n, count(*) FILTER (WHERE "createdAt" > now() - interval \'7 days\')::int AS last7 FROM "AdvertisingActionLog"'],
  ['AdMutation', 'SELECT min("createdAt")::date::text AS oldest, count(*)::int AS n, count(*) FILTER (WHERE "createdAt" > now() - interval \'7 days\')::int AS last7 FROM "AdMutation"'],
] as const) {
  const r = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(q)
  console.log(`${label.padEnd(22)} oldest=${r[0].oldest}  total=${r[0].n}  last7d=${r[0].last7}`)
}
await p.$disconnect()
