/** READ-ONLY: RT.0 progress — queue drain state, verify row, memberships, drift. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()

const recent = await prisma.outboundSyncQueue.groupBy({
  by: ['syncStatus', 'targetChannel'],
  where: { createdAt: { gte: new Date(now - 45 * 60e3) } },
  _count: { _all: true },
})
console.log('rows created last 45min by status:', JSON.stringify(recent.map((r) => `${r.targetChannel}:${r.syncStatus}=${r._count._all}`)))

const verifyRow = await prisma.outboundSyncQueue.findFirst({
  where: { payload: { path: ['source'], equals: 'RT0_HEAL_VERIFY' } },
  select: { id: true, syncStatus: true, errorCode: true, isDead: true, errorMessage: true, syncedAt: true },
})
console.log('heal-verify row:', JSON.stringify({ ...verifyRow, errorMessage: verifyRow?.errorMessage?.slice(0, 160) }))

const mems = await prisma.sharedListingMembership.groupBy({
  by: ['status'],
  where: { itemId: '256552369326' },
  _count: { _all: true },
})
console.log('dead-item memberships:', JSON.stringify(mems.map((m) => `${m.status}=${m._count._all}`)))

const pendingNow = await prisma.outboundSyncQueue.count({ where: { syncStatus: { in: ['PENDING', 'IN_PROGRESS'] }, syncType: 'QUANTITY_UPDATE' } })
const oldest = await prisma.outboundSyncQueue.findFirst({
  where: { syncStatus: 'PENDING', syncType: 'QUANTITY_UPDATE' },
  orderBy: { createdAt: 'asc' },
  select: { createdAt: true },
})
console.log(`qty PENDING/IN_PROGRESS now: ${pendingNow}; oldest pending age min: ${oldest ? Math.round((now - oldest.createdAt.getTime()) / 60e3) : 0}`)

await prisma.$disconnect()
process.exit(0)
