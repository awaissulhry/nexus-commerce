import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const t = await p.rankTarget.findMany({ select:{key:true,name:true,allOut:true,acosCapPct:true,maxCpcCents:true,maxBiasPct:true,biasPct:true,targetISPct:true,scopeCampaignId:true} })
console.log('RANK TARGETS')
for (const x of t) console.log(`  ${x.key.padEnd(18)} allOut=${String(x.allOut).padEnd(5)} acosCap=${String(x.acosCapPct ?? '—').padStart(4)} maxCpc=${x.maxCpcCents!=null?`€${(x.maxCpcCents/100).toFixed(2)}`:'NONE'}  maxBias=${x.maxBiasPct ?? 900}%  scope=${x.scopeCampaignId ?? 'global'}`)

// which schedules actually reach for all-out, and how many hours a week
const allOut = new Set(t.filter(x=>x.allOut).map(x=>x.key))
const groups = await p.rankScheduleGroup.findMany({ select:{id:true,name:true,enabled:true,windows:true,defaultTargetKey:true} })
console.log('\nSCHEDULES USING AN ALL-OUT TARGET')
let total=0
for (const g of groups) {
  const wins=(g.windows as Array<{days:number[];startHour:number;endHour:number;targetKey?:string}>)??[]
  const grid:string[][] = Array.from({length:7},()=>Array(24).fill(g.defaultTargetKey??''))
  for (const w of wins) for (const d of w.days) for (let h=w.startHour;h<w.endHour;h++) if (w.targetKey) grid[d][h]=w.targetKey
  let n=0; for(let d=0;d<7;d++)for(let h=0;h<24;h++) if(allOut.has(grid[d][h])) n++
  if (n>0) { total+=n; console.log(`  ${n.toString().padStart(3)}h/week  ${g.enabled?'ARMED ':'paused'}  ${g.name}`) }
}
console.log(`  → ${total} all-out hours per week across the account`)

// observed CPC on the campaigns those schedules control
const since=new Date(Date.now()-30*24*3600*1000)
const rows = await p.amazonAdsDailyPerformance.findMany({ where:{entityType:'CAMPAIGN',date:{gte:since}}, select:{costMicros:true,clicks:true} })
const cost=rows.reduce((n,r)=>n+Number((r.costMicros??0n)/10_000n),0), clicks=rows.reduce((n,r)=>n+(r.clicks??0),0)
console.log(`\nACCOUNT CPC (30d): €${clicks>0?(cost/100/clicks).toFixed(2):'—'} over ${clicks} clicks`)
await p.$disconnect()
