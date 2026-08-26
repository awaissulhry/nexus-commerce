import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const SUBJECT = 'cmpee8xnu0aj9oj0138qyrfxv'
const QID = 'cmspxy4zg0001njei84cgyr8p'
console.log('\n=== the pause queue row, whatever became of it ===')
const row = await prisma.outboundSyncQueue.findUnique({ where: { id: QID } })
console.log(JSON.stringify(row, null, 1))
console.log('\n=== every queue row for this subject ===')
const all = await prisma.outboundSyncQueue.findMany({
  where: { syncType: { in: ['AD_ENTITY_STATE_UPDATE', 'AD_BID_UPDATE'] } },
  select: { id: true, syncStatus: true, errorMessage: true, createdAt: true, syncedAt: true, isDead: true, payload: true },
  orderBy: { createdAt: 'desc' }, take: 200,
})
for (const r of all.filter((x) => (x.payload as { entityId?: string })?.entityId === SUBJECT)) {
  console.log(` ${r.id} ${r.createdAt.toISOString()} ${r.syncStatus} synced=${r.syncedAt?.toISOString() ?? '—'} dead=${r.isDead} err=${r.errorMessage ?? '—'}`)
  console.log(`   changes=${JSON.stringify((r.payload as { fieldChanges?: unknown }).fieldChanges)}`)
}
console.log('\n=== action logs for this subject ===')
const logs = await prisma.advertisingActionLog.findMany({ where: { entityId: SUBJECT }, select: { id: true, actionType: true, userId: true, amazonResponseStatus: true, createdAt: true, payloadBefore: true, payloadAfter: true }, orderBy: { createdAt: 'desc' }, take: 10 })
for (const l of logs) console.log(` ${l.createdAt.toISOString()} ${l.actionType} ${l.userId} amazon=${l.amazonResponseStatus} ${JSON.stringify(l.payloadBefore)}→${JSON.stringify(l.payloadAfter)}`)
console.log('\n=== the row now ===')
console.log(JSON.stringify(await prisma.adTarget.findUnique({ where: { id: SUBJECT }, select: { status: true, lastSyncedAt: true, lastSyncStatus: true, lastSyncError: true, orphanedAt: true, updatedAt: true } }), null, 1))
await prisma.$disconnect()
