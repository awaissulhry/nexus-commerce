/** ADM-P6/DC — prove the fix through the REAL route against production data.
 *  The baseline is built from the route's OWN reported window and mirrors its OWN two buckets,
 *  because a baseline that differs from the thing it audits proves nothing. */
import '../src/env.js'
import Fastify from 'fastify'
const { default: prisma } = await import('../src/db.js')
const app = Fastify({ logger: false })
const { default: advertisingRoutes } = await import('../src/routes/advertising.routes.js')
await app.register(advertisingRoutes, { prefix: '/api' })
const res = await app.inject({ method: 'GET', url: '/api/advertising/campaigns?preset=last30&limit=250' })
const parsed = JSON.parse(res.body) as { items: Array<Record<string, unknown>>; range: { startDate: string; endDate: string } }
console.log('status', res.statusCode, '· window', parsed.range.startDate, '->', parsed.range.endDate)

const truth = await prisma.$queryRawUnsafe<Array<{ cid: string; sales: number }>>(
  `SELECT "localEntityId" AS cid, (SUM("sales7dCents")/100.0)::float8 AS sales
   FROM "AmazonAdsDailyPerformance"
   WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL
     AND "date" >= $1::date AND "date" <= $2::date
   GROUP BY 1`, parsed.range.startDate, parsed.range.endDate)
const byId = new Map(truth.map(r => [r.cid, r.sales]))

let checked = 0, agree = 0; const off: string[] = []
for (const it of parsed.items) {
  const t = byId.get(String(it.id)); if (t == null) continue
  checked++
  const shown = Number(it.sales)
  if (Math.abs(shown - t) < 0.02) agree++
  else off.push(`   ${String(it.name).slice(0,30).padEnd(32)} route=${shown.toFixed(2)} headline=${t.toFixed(2)}`)
}
console.log(`campaigns compared ${checked} · route == headline column on ${agree}`)
off.slice(0,6).forEach(l => console.log(l))
const totalRoute = parsed.items.reduce((s, i) => s + Number(i.sales ?? 0), 0)
console.log(`\n30-day account ad sales: route EUR ${totalRoute.toFixed(2)} · headline EUR ${truth.reduce((s,r)=>s+r.sales,0).toFixed(2)}`)
console.log(`BEFORE this fix the same route reported EUR 18,953.19`)
await app.close(); await prisma.$disconnect(); process.exit(0)
