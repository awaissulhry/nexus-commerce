import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const out = (s: string) => console.log(`§ ${s}`)

// 1. Can we identify the LAST writer of a campaign's budget, and its direction?
const since = new Date(Date.now() - 24*3600e3)
const rows = await prisma.$queryRaw<Array<{ entityId: string; userId: string|null; before: unknown; after: unknown; createdAt: Date }>>`
  SELECT DISTINCT ON ("entityId") "entityId", "userId", "payloadBefore" AS before, "payloadAfter" AS after, "createdAt"
  FROM "AdvertisingActionLog"
  WHERE "actionType"='AD_BUDGET_UPDATE' AND "createdAt" >= ${since}
  ORDER BY "entityId", "createdAt" DESC`
out(`Campaigns with a budget write in 24h: ${rows.length} — last writer identifiable for ALL of them`)
const byActor = new Map<string, {n:number; up:number; down:number}>()
for (const r of rows) {
  const b = Number((r.before as any)?.dailyBudget ?? NaN), a = Number((r.after as any)?.dailyBudget ?? NaN)
  const k = r.userId ?? 'null'
  const e = byActor.get(k) ?? {n:0,up:0,down:0}
  e.n++; if (a > b) e.up++; else if (a < b) e.down++
  byActor.set(k, e)
}
for (const [k,v] of [...byActor].sort((a,b)=>b[1].n-a[1].n)) console.log(`  · ${k}: ${v.n} campaigns — ${v.up} raised, ${v.down} cut`)

// 2. Is the pacer's direction envelope-driven (i.e. does it CUT when the month is over pace)?
const plans = await prisma.adBudgetPlan.findMany({ where: { month: '2026-08' } })
const envelope = plans.reduce((a,p)=>a+p.monthlyBudgetCents,0)/100
const spendRows = await prisma.$queryRaw<Array<{ mkt: string; spend: bigint }>>`
  SELECT "marketplace" mkt, SUM("costMicros") spend FROM "AmazonAdsHourlyPerformance"
  WHERE "date" >= '2026-08-01' GROUP BY 1`
const monthSpend = spendRows.reduce((a,r)=>a+Number(r.spend)/1e6, 0)
const dayOfMonth = new Date().getUTCDate()
out(`Monthly envelope €${envelope.toFixed(2)} · spent so far €${monthSpend.toFixed(2)} · day ${dayOfMonth}/31`)
out(`Pace: expected €${(envelope*dayOfMonth/31).toFixed(2)} by now → ${monthSpend > envelope*dayOfMonth/31 ? 'OVER pace (the pacer will be CUTTING)' : 'under pace'}`)

// 3. How much headroom would a schedule have if it obeyed the envelope?
const daysLeft = 31 - dayOfMonth + 1
out(`Remaining envelope €${(envelope-monthSpend).toFixed(2)} over ${daysLeft} days = €${((envelope-monthSpend)/daysLeft).toFixed(2)}/day`)
const enabled = await prisma.campaign.count({ where: { status: 'ENABLED' } })
out(`…across ${enabled} enabled campaigns = €${((envelope-monthSpend)/daysLeft/enabled).toFixed(2)}/campaign/day average`)
await prisma.$disconnect()
