import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
const members = await p.adSchedule.findMany({ where: { groupId: { not: null } }, select: { groupId: true, campaignId: true } })
const groups = await p.rankScheduleGroup.findMany({ select: { id: true, name: true } })
const camps = await p.campaign.findMany({ where: { id: { in: [...new Set(members.map(m=>m.campaignId))] } }, select: { id: true, externalCampaignId: true } })
const ext = new Map(camps.filter(c=>c.externalCampaignId).map(c=>[c.externalCampaignId!, c.id]))
const rows = await p.amazonAdsDailyPerformance.findMany({
  where: { entityType: 'CAMPAIGN', date: { gte: since }, OR: [{ localEntityId: { in: camps.map(c=>c.id) } }, { entityId: { in: [...ext.keys()] } }] },
  select: { localEntityId: true, entityId: true, costMicros: true, sales7dCents: true },
})
const perf = new Map<string, {c:number;s:number}>()
for (const r of rows) { const cid = r.localEntityId ?? ext.get(r.entityId); if (!cid) continue
  const e = perf.get(cid) ?? {c:0,s:0}; e.c += Number((r.costMicros ?? 0n)/10_000n); e.s += r.sales7dCents ?? 0; perf.set(cid, e) }
const out = groups.map(g => {
  const ms = members.filter(m => m.groupId === g.id)
  const t = ms.reduce((a,m)=>{const e=perf.get(m.campaignId); return e?{c:a.c+e.c,s:a.s+e.s}:a},{c:0,s:0})
  return { name: g.name.slice(0,30), campaigns: ms.length, spend: `€${(t.c/100).toFixed(0)}`, sales: `€${(t.s/100).toFixed(0)}`, acos: t.s>0?`${Math.round(t.c/t.s*1000)/10}%`:'—' }
}).sort((a,b)=>parseFloat(b.spend.slice(1))-parseFloat(a.spend.slice(1)))
console.table(out.slice(0,10))
await p.$disconnect()
