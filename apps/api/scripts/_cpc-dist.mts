import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now()-60*24*3600*1000)
// per campaign-day CPC, so a single expensive day is visible rather than averaged away
const rows = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(`
  SELECT round((SUM("costMicros")/10000.0)/NULLIF(SUM(clicks),0)/100.0, 2) AS cpc, SUM(clicks)::int AS clicks
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND date >= $1 AND clicks > 0
  GROUP BY "entityId", date HAVING SUM(clicks) > 0 ORDER BY 1 DESC`, since)
const cpcs = rows.map(r=>Number(r.cpc)).filter(n=>Number.isFinite(n))
const clicks = rows.map(r=>Number(r.clicks))
const totalClicks = clicks.reduce((a,b)=>a+b,0)
const pct = (q:number) => { const s=[...cpcs].sort((a,b)=>a-b); return s[Math.floor(s.length*q)] }
console.log(`campaign-days with clicks: ${cpcs.length} · ${totalClicks} clicks (60d)`)
console.log(`  median CPC   €${pct(0.5)?.toFixed(2)}`)
console.log(`  p90 CPC      €${pct(0.9)?.toFixed(2)}`)
console.log(`  p99 CPC      €${pct(0.99)?.toFixed(2)}`)
console.log(`  max CPC      €${Math.max(...cpcs).toFixed(2)}`)
for (const cap of [1.00,1.25,1.50,2.00]) {
  const over = rows.filter(r=>Number(r.cpc)>cap)
  const overClicks = over.reduce((n,r)=>n+Number(r.clicks),0)
  console.log(`  a €${cap.toFixed(2)} cap would have bound on ${over.length}/${cpcs.length} campaign-days (${Math.round(overClicks/totalClicks*100)}% of clicks)`)
}
await p.$disconnect()
