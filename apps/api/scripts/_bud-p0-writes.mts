import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: new Date(Date.now() - 7 * 864e5) } }, _count: true,
})
for (const r of rows.sort((a, b) => Number(b._count) - Number(a._count))) console.log(`${r._count}  ${r.userId}`)
await prisma.$disconnect()
