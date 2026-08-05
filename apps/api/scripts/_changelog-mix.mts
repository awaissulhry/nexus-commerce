import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
const hist = await p.campaignBidHistory.groupBy({ by: ['changedBy'], where: { changedAt: { gte: since } }, _count: true })
const kind = (a: string) => a.startsWith('automation:rank-defend-') ? 'rank schedule'
  : a.startsWith('automation:rank-plan-') ? 'family plan'
  : a.startsWith('automation:rule-') ? 'rule'
  : a.startsWith('automation:') ? `job (${a.slice(11)})` : 'operator/other'
const tally = new Map<string, number>()
for (const h of hist) tally.set(kind(h.changedBy), (tally.get(kind(h.changedBy)) ?? 0) + h._count)
const tot = [...tally.values()].reduce((a,b)=>a+b,0)
console.log(`CampaignBidHistory, last 7 days — ${tot} rows`)
for (const [k,v] of [...tally].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(Math.round(v/tot*100)).padStart(3)}%  ${String(v).padStart(5)}  ${k}`)
const log = await p.advertisingActionLog.groupBy({ by: ['actionType'], where: { createdAt: { gte: since } }, _count: true })
console.log(`\nAdvertisingActionLog, last 7 days — by actionType`)
for (const l of log.sort((a,b)=>b._count-a._count).slice(0,8)) console.log(`  ${String(l._count).padStart(5)}  ${l.actionType}`)
await p.$disconnect()
