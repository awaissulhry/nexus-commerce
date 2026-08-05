import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const names = ['GALE | IT | PAT', 'GALE | IT | Exact | Category']
const camps = await p.campaign.findMany({ where: { name: { in: names } }, select: { id:true,name:true,externalCampaignId:true } })
const since = new Date(Date.now() - 30*24*3600*1000)

for (const c of camps) {
  console.log(`\n=== ${c.name} ===`)
  const ags = await p.adGroup.findMany({ where: { campaignId: c.id }, select: { id:true, name:true } })
  const tg = await p.adTarget.findMany({
    where: { adGroupId: { in: ags.map(a=>a.id) }, isNegative: false },
    select: { id:true, externalTargetId:true, kind:true, expressionType:true, expressionValue:true, bidCents:true, status:true },
  })
  console.log(`  ${tg.length} targets · ${ags.length} ad group(s)`)
  const extIds = tg.map(t=>t.externalTargetId).filter(Boolean) as string[]
  const perf = extIds.length ? await p.amazonAdsDailyPerformance.findMany({
    where: { entityType:'AD_TARGET', entityId:{in:extIds}, date:{gte:since} },
    select: { entityId:true, costMicros:true, sales7dCents:true, orders7d:true, clicks:true, impressions:true },
  }) : []
  const agg = new Map<string,{c:number;s:number;o:number;cl:number;im:number}>()
  for (const r of perf) { const e = agg.get(r.entityId) ?? {c:0,s:0,o:0,cl:0,im:0}
    e.c+=Number((r.costMicros??0n)/10_000n); e.s+=r.sales7dCents??0; e.o+=r.orders7d??0; e.cl+=r.clicks??0; e.im+=r.impressions??0; agg.set(r.entityId,e) }
  const rows = tg.map(t=>{ const e = t.externalTargetId ? agg.get(t.externalTargetId) : undefined
    return { target: String(t.expressionValue ?? t.kind).slice(0,30), type: t.expressionType ?? t.kind, bid:`€${(t.bidCents/100).toFixed(2)}`,
      spend: e?`€${(e.c/100).toFixed(2)}`:'€0', clicks: e?.cl??0, orders: e?.o??0,
      cvr: e&&e.cl>0?`${Math.round(e.o/e.cl*1000)/10}%`:'—' } })
    .filter(r=>r.clicks>0).sort((a,b)=>parseFloat(b.spend.slice(1))-parseFloat(a.spend.slice(1)))
  console.table(rows.slice(0,12))
  const zero = rows.filter(r=>r.orders===0)
  const wastedC = zero.reduce((n,r)=>n+parseFloat(r.spend.slice(1)),0)
  const wastedCl = zero.reduce((n,r)=>n+r.clicks,0)
  console.log(`  targets with clicks but ZERO orders: ${zero.length}/${rows.length} — €${wastedC.toFixed(0)} across ${wastedCl} clicks`)
}
await p.$disconnect()
