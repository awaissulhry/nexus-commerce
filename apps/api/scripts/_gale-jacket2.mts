import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const g = (await p.rankScheduleGroup.findFirst({ where: { name: 'IT GALE JACKET' } }))!
const wins = (g.windows as Array<{days:number[];startHour:number;endHour:number;targetKey?:string}>) ?? []
// compile to 7x24
const grid: string[][] = Array.from({length:7},()=>Array(24).fill(g.defaultTargetKey ?? ''))
for (const w of wins) for (const d of w.days) for (let h=w.startHour; h<w.endHour; h++) if (w.targetKey) grid[d][h]=w.targetKey
const tally = new Map<string,number>()
for (let d=0;d<7;d++) for (let h=0;h<24;h++) tally.set(grid[d][h], (tally.get(grid[d][h])??0)+1)
const targets = await p.rankTarget.findMany({ select:{key:true,name:true,allOut:true,acosCapPct:true,maxBiasPct:true,maxCpcCents:true} })
const T = new Map(targets.map(t=>[t.key,t]))
console.log('HOURS OF THE WEEK BY TARGET (168 total)')
for (const [k,n] of [...tally].sort((a,b)=>b[1]-a[1])) {
  const t = T.get(k)
  console.log(`  ${String(n).padStart(3)}h  ${String(Math.round(n/168*100)).padStart(3)}%  ${(t?.name??k).padEnd(22)} ${t?.allOut?'ALL-OUT (ignores ACoS cap)':`acosCap=${t?.acosCapPct ?? 'none'}`}  maxBias=${t?.maxBiasPct ?? 900}%  maxCpc=${t?.maxCpcCents!=null?`€${(t.maxCpcCents/100).toFixed(2)}`:'none'}`)
}
// demand vs all-out hours
const members = await p.adSchedule.findMany({ where:{groupId:g.id}, select:{campaignId:true} })
const camps = await p.campaign.findMany({ where:{id:{in:members.map(m=>m.campaignId)}}, select:{id:true,externalCampaignId:true} })
const { hourlyCells } = await import('../src/services/advertising/ads-hourly.service.js')
const { cells } = await hourlyCells({ campaignIds: camps.map(c=>c.id), windowDays: 56, tz: 'Europe/Rome' })
const allOutKeys = new Set(targets.filter(t=>t.allOut).map(t=>t.key))
let inAll = {c:0,s:0}, outAll = {c:0,s:0}
for (const c of cells) { const t = allOutKeys.has(grid[c.dow][c.hour]) ? inAll : outAll; t.c+=c.costCents; t.s+=c.salesCents }
const pctOf=(a:number,b:number)=> a+b>0?Math.round(a/(a+b)*1000)/10:0
console.log(`\nALL-OUT hours: ${[...tally].filter(([k])=>allOutKeys.has(k)).reduce((n,[,v])=>n+v,0)} of 168`)
console.log(`  spend in all-out hours: €${(inAll.c/100).toFixed(0)} (${pctOf(inAll.c,outAll.c)}% of spend)`)
console.log(`  sales in all-out hours: €${(inAll.s/100).toFixed(0)} (${pctOf(inAll.s,outAll.s)}% of sales)`)
console.log(`  ACoS inside all-out : ${inAll.s>0?`${Math.round(inAll.c/inAll.s*1000)/10}%`:'—'}`)
console.log(`  ACoS elsewhere      : ${outAll.s>0?`${Math.round(outAll.c/outAll.s*1000)/10}%`:'—'}`)
await p.$disconnect()
