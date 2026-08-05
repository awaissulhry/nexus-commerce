import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now() - 20 * 60 * 1000)
const q = await p.outboundSyncQueue.findMany({
  where: { createdAt: { gte: since }, syncType: { contains: 'AD_' } },
  select: { id: true, syncType: true, syncStatus: true, errorMessage: true, errorCode: true, retryCount: true, createdAt: true, payload: true },
  orderBy: { createdAt: 'desc' }, take: 30,
})
console.log(`OutboundSyncQueue AD_TARGET rows in last 20 min: ${q.length}`)
for (const r of q) console.log(`  ${r.syncStatus.padEnd(9)} ${r.syncType.padEnd(22)} ${r.errorCode ?? ''} ${String(r.errorMessage ?? '').slice(0,80)} ${JSON.stringify(r.payload).slice(0,80)}`)
const mut = await p.adMutation.findMany({ where: { entityType: 'AD_TARGET', createdAt: { gte: since } }, select: { state: true, actor: true } })
const tally = new Map<string, number>()
for (const m of mut) tally.set(`${m.actor}/${m.state}`, (tally.get(`${m.actor}/${m.state}`) ?? 0)+1)
console.log('\nAdMutation created in last 20 min:', JSON.stringify([...tally]))
await p.$disconnect()
