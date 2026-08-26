import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { getCoverageEngineLog } = await import('../src/services/advertising/ads-coverage-engine.service.js')
// A real championed target id so the term/campaign join is exercised.
const made = await prisma.advertisingActionLog.create({
  data: {
    actionType: 'coverage_engine_observe',
    entityType: 'AD_TARGET',
    entityId: 'cmpsr2j4j01r7ry01lenuh91c',
    payloadBefore: { bidCents: 20 },
    payloadAfter: { wouldSetBidCents: 22, action: 'up' },
    amazonResponseStatus: 'SUCCESS',
    evidence: { metric: 'coverage_share', observed: '1.20%', threshold: '3%', reason: 'probe row — will be deleted' } as never,
  },
})
const rows = await getCoverageEngineLog(1)
console.log('mapped:', JSON.stringify(rows.find((r) => r.reason?.includes('probe row')), null, 1))
await prisma.advertisingActionLog.delete({ where: { id: made.id } })
console.log('probe row deleted:', made.id)
await prisma.$disconnect()
process.exit(0)
