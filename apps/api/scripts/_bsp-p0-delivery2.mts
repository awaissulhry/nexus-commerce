import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const out = (s: string) => console.log(`§ ${s}`)
const rows = await prisma.$queryRaw<Array<{ deliveryStatus: string|null; deliveryProfile: string|null; n: bigint }>>`
  SELECT "deliveryStatus", "deliveryProfile", COUNT(*) n FROM "Campaign" WHERE "status"='ENABLED' GROUP BY 1,2 ORDER BY n DESC`
out('Campaign delivery fields (ENABLED)')
for (const r of rows) console.log(`  · status=${r.deliveryStatus ?? 'null'} profile=${r.deliveryProfile ?? 'null'} — ${Number(r.n)}`)
const ex = await prisma.$queryRaw<Array<{ name: string; deliveryStatus: string|null; deliveryReasons: unknown }>>`
  SELECT "name","deliveryStatus","deliveryReasons" FROM "Campaign" WHERE "status"='ENABLED' AND "deliveryReasons" IS NOT NULL LIMIT 6`
for (const r of ex) console.log(`    ! ${r.name} — ${r.deliveryStatus} ${JSON.stringify(r.deliveryReasons)}`)

// Do campaigns run out of budget? hours with spend, per campaign per day — last hour of spend
const dark = await prisma.$queryRaw<Array<{ entityId: string; d: Date; lasth: number; spend: bigint }>>`
  SELECT "entityId", "date"::date d, MAX("hour") lasth, SUM("costMicros") spend
  FROM "AmazonAdsHourlyPerformance" WHERE "costMicros" > 0 AND "date" >= NOW() - INTERVAL '14 days'
  GROUP BY 1,2 ORDER BY 2 DESC, 4 DESC LIMIT 1`
out(`sample last-spending-hour row: ${JSON.stringify(dark[0] ? {d: dark[0].d.toISOString().slice(0,10), lasth: dark[0].lasth} : null)}`)
const dist = await prisma.$queryRaw<Array<{ lasth: number; n: bigint }>>`
  SELECT lasth, COUNT(*) n FROM (
    SELECT "entityId", "date"::date d, MAX("hour") lasth FROM "AmazonAdsHourlyPerformance"
    WHERE "costMicros" > 0 AND "date" >= NOW() - INTERVAL '14 days' GROUP BY 1,2) t
  GROUP BY 1 ORDER BY 1`
out('Distribution of the LAST UTC hour a campaign-day spent (14d) — the out-of-budget signal this page owns and does not show')
for (const r of dist) console.log(`  · last spend at h${String(r.lasth).padStart(2,'0')} UTC — ${Number(r.n)} campaign-days`)
await prisma.$disconnect()
