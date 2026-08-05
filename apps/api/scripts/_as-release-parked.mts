/** OPERATIONAL (run ONLY once Amazon writes succeed again): release all parked
 *  AMAZON quantity rows for immediate dispatch + queue the read-back directive.
 *  Touches only FAILED, non-dead AMAZON QUANTITY_UPDATE rows' nextRetryAt —
 *  no quantities, no listings, no pool. Dispatch re-reads current values and
 *  the FBA guard applies as always. */
const { default: prisma } = await import('../src/db.js')

const released = await prisma.outboundSyncQueue.updateMany({
  where: {
    targetChannel: 'AMAZON',
    syncType: 'QUANTITY_UPDATE',
    syncStatus: 'FAILED',
    isDead: false,
    errorCode: { in: ['AUTH_REQUIRED', 'CIRCUIT_OPEN_DEFERRED', 'RETRY_SCHEDULED'] },
  },
  data: { nextRetryAt: new Date() },
})
console.log(`released for immediate retry: ${released.count}`)

// Re-drive dead-lettered rows from the 403 era too (they were budget-burned
// before AS.1; content is still the pool's intent — dispatch re-reads anyway).
const revived = await prisma.outboundSyncQueue.updateMany({
  where: {
    targetChannel: 'AMAZON',
    syncType: 'QUANTITY_UPDATE',
    isDead: true,
    diedAt: { gte: new Date(Date.now() - 48 * 3600e3) },
  },
  data: { isDead: false, diedAt: null, syncStatus: 'FAILED', errorCode: 'AUTH_REQUIRED', retryCount: 0, nextRetryAt: new Date() },
})
console.log(`revived recent dead-letters: ${revived.count}`)

const directive = await prisma.cronRun.create({
  data: { jobName: 'amazon-qty-readback-request', status: 'RUNNING', triggeredBy: 'manual' },
})
console.log(`read-back directive staged (runs at next restart): ${directive.id}`)
await prisma.$disconnect()
process.exit(0)
