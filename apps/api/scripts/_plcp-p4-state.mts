/** Read-only: exactly what the probe changed on `Regal Product Trageting`. Writes nothing. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const ID = 'cmpee2fmt09o7oj01v9jjttyy'
const c = await prisma.campaign.findUnique({ where: { id: ID }, select: { name: true, status: true, marketplace: true, externalCampaignId: true, liveBidWritesEnabled: true, dynamicBidding: true, lastSyncStatus: true, lastSyncedAt: true } })
console.log(JSON.stringify(c, null, 2))
const hist = await prisma.campaignBidHistory.findMany({ where: { campaignId: ID, field: { startsWith: 'PLACEMENT' } }, orderBy: { changedAt: 'asc' }, select: { field: true, oldValue: true, newValue: true, changedBy: true, reason: true, changedAt: true } })
console.log(`\nCampaignBidHistory placement rows: ${hist.length}`)
for (const h of hist) console.log(`  ${h.changedAt.toISOString()} ${h.field} ${h.oldValue}→${h.newValue} by ${h.changedBy} · ${h.reason}`)
const logs = await prisma.advertisingActionLog.findMany({ where: { entityId: ID, actionType: 'update_placement_bidding' }, orderBy: { createdAt: 'desc' }, take: 3, select: { createdAt: true, userId: true, amazonResponseStatus: true, payloadBefore: true, payloadAfter: true } })
console.log(`\naudit rows: ${logs.length}`)
for (const l of logs) console.log(`  ${l.createdAt.toISOString()} ${l.amazonResponseStatus} by ${l.userId}\n    before=${JSON.stringify(l.payloadBefore)}\n    after=${JSON.stringify(l.payloadAfter)}`)
await prisma.$disconnect()
