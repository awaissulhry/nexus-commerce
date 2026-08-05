import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const camps = await p.campaign.findMany({ where: { name: { in: ['GALE | IT | PAT','GALE | IT | Exact | Category'] } }, select:{id:true,name:true,externalCampaignId:true} })
const since = new Date(Date.now() - 30*24*3600*1000)
for (const c of camps) {
  const ids = [c.externalCampaignId, c.id].filter(Boolean) as string[]
  const rows = await p.amazonAdsSearchTerm.findMany({ where: { campaignId: { in: ids }, date: { gte: since } },
    select: { query:true, matchType:true, costMicros:true, sales7dCents:true, orders7d:true, clicks:true } })
  if (!rows.length) { console.log(`\n=== ${c.name} === no search-term rows`); continue }
  const agg = new Map<string,{c:number;s:number;o:number;cl:number;mt:string}>()
  for (const r of rows) { const k=r.query; const e=agg.get(k)??{c:0,s:0,o:0,cl:0,mt:r.matchType??''}
    e.c+=Number((r.costMicros??0n)/10_000n); e.s+=r.sales7dCents??0; e.o+=r.orders7d??0; e.cl+=r.clicks??0; agg.set(k,e) }
  const all=[...agg.entries()].map(([q,e])=>({query:q.slice(0,38),match:e.mt,spend:e.c,clicks:e.cl,orders:e.o,sales:e.s}))
  const spend=all.reduce((n,r)=>n+r.spend,0), zero=all.filter(r=>r.orders===0)
  console.log(`\n=== ${c.name} ===  ${all.length} queries · €${(spend/100).toFixed(0)} spend`)
  console.log(`  ZERO-ORDER queries: ${zero.length}/${all.length} — €${(zero.reduce((n,r)=>n+r.spend,0)/100).toFixed(0)} (${Math.round(zero.reduce((n,r)=>n+r.spend,0)/spend*100)}% of spend) across ${zero.reduce((n,r)=>n+r.clicks,0)} clicks`)
  console.log('  top spenders:')
  console.table(all.sort((a,b)=>b.spend-a.spend).slice(0,10).map(r=>({query:r.query,match:r.match,spend:`€${(r.spend/100).toFixed(2)}`,clicks:r.clicks,orders:r.orders,sales:`€${(r.sales/100).toFixed(0)}`})))
}
await p.$disconnect()
