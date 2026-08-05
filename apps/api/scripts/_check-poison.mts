const { default: prisma } = await import('../src/db.js')
const m = await prisma.sharedListingMembership.groupBy({ by: ['status'], where: { itemId: '256552369326' }, _count: { _all: true } })
console.log('itemId 256552369326 memberships by status:', JSON.stringify(m))
// recent eBay circuit-freeze / poison failures 7d
const poison = await prisma.outboundSyncQueue.count({ where: { externalListingId: '256552369326', isDead: true, diedAt: { gte: new Date(Date.now()-7*24*3600e3) } } })
console.log('poison dead-letters 7d:', poison)
await prisma.$disconnect()
