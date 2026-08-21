import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const lo = new Date('2026-08-21T19:15:00Z'), hi = new Date('2026-08-21T19:26:00Z')
const g = await prisma.advertisingActionLog.groupBy({ by: ['actionType','userId'], where: { createdAt: { gte: lo, lte: hi } }, _count: { _all: true } })
console.log('AdvertisingActionLog 19:15-19:26 by (actionType,userId):')
if (!g.length) console.log('  (none)')
for (const r of g) console.log(`  ${r.actionType} ${r.userId} = ${r._count._all}`)
const anyLog = await prisma.advertisingActionLog.findMany({ where: { createdAt: { gte: lo, lte: hi } }, take: 5, select: { createdAt: true, actionType: true, userId: true, entityType: true } })
for (const a of anyLog) console.log(`   e.g. ${a.createdAt.toISOString()} ${a.actionType} ${a.userId} ${a.entityType}`)
// Did anything else write campaigns in that window (status changes only)?
const c = await prisma.campaign.groupBy({ by: ['status'], where: { updatedAt: { gte: lo, lte: hi } }, _count: { _all: true } })
console.log('\nCampaign rows updated 19:15-19:26 by resulting status:')
for (const r of c) console.log(`  ${r.status} = ${r._count._all}`)
await prisma.$disconnect()
