import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const g = await p.rankScheduleGroup.findFirst({ where: { name: 'IT GALE JACKET' } })
if (!g) { console.log('not found'); process.exit(0) }
console.log(`=== ${g.name} ===`)
console.log(`enabled=${g.enabled}  tz=${g.timezone}  baseline=${g.defaultTargetKey}`)
const wins = (g.windows as Array<{days:number[];startHour:number;endHour:number;targetKey?:string}>) ?? []
const D=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
console.log(`windows (${wins.length}):`)
for (const w of wins) console.log(`   ${w.days.map(d=>D[d]).join(',')}  ${String(w.startHour).padStart(2,'0')}:00-${String(w.endHour).padStart(2,'0')}:00  → ${w.targetKey}`)

const members = await p.adSchedule.findMany({ where: { groupId: g.id }, select: { campaignId: true, enabled: true, lastApplied: true } })
const camps = await p.campaign.findMany({ where: { id: { in: members.map(m=>m.campaignId) } }, select: { id:true,name:true,externalCampaignId:true,status:true,liveBidWritesEnabled:true,dailyBudget:true } })
const ext = new Map(camps.filter(c=>c.externalCampaignId).map(c=>[c.externalCampaignId!, c.id]))
const since = new Date(Date.now() - 30*24*3600*1000)
const rows = await p.amazonAdsDailyPerformance.findMany({
  where: { entityType:'CAMPAIGN', date:{gte:since}, OR:[{localEntityId:{in:camps.map(c=>c.id)}},{entityId:{in:[...ext.keys()]}}] },
  select: { localEntityId:true, entityId:true, costMicros:true, sales7dCents:true, orders7d:true, clicks:true, impressions:true },
})
const perf = new Map<string,{c:number;s:number;o:number;cl:number;im:number}>()
for (const r of rows) { const id = r.localEntityId ?? ext.get(r.entityId); if(!id) continue
  const e = perf.get(id) ?? {c:0,s:0,o:0,cl:0,im:0}
  e.c+=Number((r.costMicros??0n)/10_000n); e.s+=r.sales7dCents??0; e.o+=r.orders7d??0; e.cl+=r.clicks??0; e.im+=r.impressions??0
  perf.set(id,e) }
console.log('\nper campaign, 30 days:')
const tbl = camps.map(c=>{ const e=perf.get(c.id)??{c:0,s:0,o:0,cl:0,im:0}
  return { campaign:c.name.slice(0,34), status:c.status, live:c.liveBidWritesEnabled?'ON':'OFF',
    spend:`€${(e.c/100).toFixed(0)}`, sales:`€${(e.s/100).toFixed(0)}`, orders:e.o, clicks:e.cl,
    acos: e.s>0?`${Math.round(e.c/e.s*1000)/10}%`:'—',
    cpc: e.cl>0?`€${(e.c/100/e.cl).toFixed(2)}`:'—' } })
  .sort((a,b)=>parseFloat(b.spend.slice(1))-parseFloat(a.spend.slice(1)))
console.table(tbl)
await p.$disconnect()
