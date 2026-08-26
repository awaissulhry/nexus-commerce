import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const out = (s: string) => console.log(`§ ${s}`)

// coverage by day: rows, non-zero cost rows, distinct campaigns
const cov = await prisma.$queryRaw<Array<{ d: Date; rows: bigint; live: bigint; camps: bigint; cost: bigint }>>`
  SELECT "date"::date AS d, COUNT(*) AS rows, COUNT(*) FILTER (WHERE "costMicros" > 0) AS live,
         COUNT(DISTINCT "entityId") AS camps, SUM("costMicros") AS cost
  FROM "AmazonAdsHourlyPerformance" WHERE "date" >= NOW() - INTERVAL '70 days'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 14`
out('AmazonAdsHourlyPerformance — last 14 days present')
for (const r of cov) console.log(`  · ${r.d.toISOString().slice(0,10)}  rows=${Number(r.rows)}  cost>0=${Number(r.live)}  campaigns=${Number(r.camps)}  spend=€${(Number(r.cost??0n)/1e6).toFixed(2)}`)

const span = await prisma.$queryRaw<Array<{ mn: Date; mx: Date; n: bigint; days: bigint }>>`
  SELECT MIN("date") mn, MAX("date") mx, COUNT(*) n, COUNT(DISTINCT "date"::date) days FROM "AmazonAdsHourlyPerformance"`
out(`Full span: ${span[0].mn?.toISOString().slice(0,10)} → ${span[0].mx?.toISOString().slice(0,10)}  rows=${Number(span[0].n)}  distinct days=${Number(span[0].days)}`)

// what the endpoint returns: 60-day window, hour-of-day in Rome
const since = new Date(); since.setUTCDate(since.getUTCDate()-60); since.setUTCHours(0,0,0,0)
const rows = await prisma.$queryRaw<Array<{ hour: number; cost: bigint|null; sales: bigint|null; orders: bigint|null }>>`
  SELECT EXTRACT(HOUR FROM ts_rome)::int AS hour, SUM("costMicros") AS cost, SUM(COALESCE("sales7dCents",0)) AS sales, SUM(COALESCE("orders7d",0)) AS orders
  FROM (SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') AS ts_rome, "costMicros","sales7dCents","orders7d"
        FROM "AmazonAdsHourlyPerformance" WHERE "date" >= ${since}) t
  GROUP BY hour ORDER BY hour`
out(`hourly-performance endpoint shape (60d from ${since.toISOString().slice(0,10)}): ${rows.length} hour buckets`)
let zeroSales = 0
for (const r of rows) { const sp=Number(r.cost??0n)/1e6, sa=Number(r.sales??0n)/100; if (sa===0) zeroSales++
  console.log(`  h${String(r.hour).padStart(2,'0')} spend=€${sp.toFixed(2)} sales=€${sa.toFixed(2)} orders=${Number(r.orders??0n)} acos=${sa>0?((sp/sa)*100).toFixed(1)+'%':'NULL → client plots 0%'}`) }
out(`hours with ZERO sales (ACoS null → rendered as 0%): ${zeroSales} of ${rows.length}`)

// marketplace split — does the store even carry a marketplace?
const cols = await prisma.$queryRaw<Array<{ column_name: string; data_type: string }>>`
  SELECT column_name, data_type FROM information_schema.columns WHERE table_name='AmazonAdsHourlyPerformance' ORDER BY ordinal_position`
out(`AmazonAdsHourlyPerformance columns: ${cols.map(c=>c.column_name).join(', ')}`)

await prisma.$disconnect()
