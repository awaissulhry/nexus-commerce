import prisma from '../src/db.js'
const ids = [...new Set((await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'CAMPAIGN', createdAt: { gte: new Date('2026-08-21T19:25:00Z'), lte: new Date('2026-08-21T19:40:00Z') } },
  select: { entityId: true } })).map((r) => r.entityId))]
const camps = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { name: true, status: true }, orderBy: { name: 'asc' } })
console.log('local status of the 20:'); for (const c of camps) console.log(`  ${String(c.name).slice(0,42).padEnd(42)} ${c.status}`)
const q = await prisma.outboundSyncQueue.findMany({ where: { syncType: 'AD_ENTITY_STATE_UPDATE', createdAt: { gt: new Date(Date.now() - 30*60*1000) } }, select: { id: true, syncStatus: true, retryCount: true, errorMessage: true, createdAt: true } })
console.log(`\nqueue rows created in the last 30 min: ${q.length}`)
for (const r of q) console.log(`  ${r.createdAt.toISOString().slice(11,19)} ${String(r.syncStatus).padEnd(12)} retry=${r.retryCount} ${r.errorMessage?.slice(0,70) ?? ''}`)
const logs = await prisma.advertisingActionLog.count({ where: { actionType: 'AD_ENTITY_STATE_UPDATE', createdAt: { gt: new Date(Date.now() - 30*60*1000) } } })
console.log(`action-log rows in the last 30 min: ${logs}`)
await prisma.$disconnect()
