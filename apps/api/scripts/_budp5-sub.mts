import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const c = await prisma.campaign.findFirst({ where: { name: 'DE_Auto_Substitute' }, select: { id: true, name: true, status: true, dailyBudget: true, updatedAt: true, marketplace: true } })
console.log(JSON.stringify(c, null, 1))
const logs = await prisma.advertisingActionLog.findMany({ where: { entityId: c?.id, createdAt: { gte: new Date(Date.now() - 12*3600e3) } }, orderBy: { createdAt: 'desc' }, take: 6, select: { createdAt: true, actionType: true, userId: true, payloadBefore: true, payloadAfter: true } })
console.log('recent action log:'); for (const l of logs) console.log(`  ${l.createdAt.toISOString()} ${l.actionType} ${l.userId} ${JSON.stringify(l.payloadBefore)} -> ${JSON.stringify(l.payloadAfter)}`)
await prisma.$disconnect()
