import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const out = (s: string) => console.log(`§ ${s}`)
const since = new Date(); since.setUTCDate(since.getUTCDate()-60); since.setUTCHours(0,0,0,0)

const mk = await prisma.$queryRaw<Array<{ marketplace: string; adProduct: string; rows: bigint; cost: bigint; sales: bigint }>>`
  SELECT "marketplace", "adProduct", COUNT(*) rows, SUM("costMicros") cost, SUM(COALESCE("sales7dCents",0)) sales
  FROM "AmazonAdsHourlyPerformance" WHERE "date" >= ${since} GROUP BY 1,2 ORDER BY cost DESC`
out('Hourly store by marketplace × adProduct, last 60d — the chart SUMS ALL OF THESE into one line')
for (const r of mk) console.log(`  · ${r.marketplace} ${r.adProduct}: rows=${Number(r.rows)} spend=€${(Number(r.cost)/1e6).toFixed(2)} sales=€${(Number(r.sales)/100).toFixed(2)}`)

// peak hour per market — do markets disagree about when to spend?
const ph = await prisma.$queryRaw<Array<{ marketplace: string; hour: number; cost: bigint }>>`
  SELECT "marketplace", EXTRACT(HOUR FROM ts)::int AS hour, SUM("costMicros") cost FROM (
    SELECT "marketplace", (("date" + (("hour")::text||' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') ts, "costMicros"
    FROM "AmazonAdsHourlyPerformance" WHERE "date" >= ${since}) t
  GROUP BY 1,2 ORDER BY 1, cost DESC`
const best = new Map<string, {hour:number;cost:number}[]>()
for (const r of ph) { const a = best.get(r.marketplace) ?? []; a.push({hour:r.hour, cost:Number(r.cost)/1e6}); best.set(r.marketplace, a) }
out('Top 3 spend hours per market (Rome)')
for (const [m, a] of best) console.log(`  · ${m}: ${a.slice(0,3).map(x=>`h${String(x.hour).padStart(2,'0')} €${x.cost.toFixed(2)}`).join('  ')}`)

// out-of-budget signal? any column recording it
const cols = await prisma.$queryRaw<Array<{ c: string }>>`
  SELECT column_name::text AS c FROM information_schema.columns WHERE table_name='AmazonAdsHourlyPerformance' ORDER BY ordinal_position`
out(`hourly columns: ${cols.map(x=>x.c).join(', ')}`)

// outbound queue truth for budget writes
const oq = await prisma.$queryRaw<Array<{ status: string; n: bigint }>>`
  SELECT "status", COUNT(*) n FROM "AdOutboundQueue" WHERE "syncType"='AD_BUDGET_UPDATE' AND "createdAt" >= NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY n DESC`
out('AdOutboundQueue AD_BUDGET_UPDATE, 7d — the DELIVERY truth nothing on this page reads')
for (const r of oq) console.log(`  · ${r.status}: ${Number(r.n)}`)

await prisma.$disconnect()
