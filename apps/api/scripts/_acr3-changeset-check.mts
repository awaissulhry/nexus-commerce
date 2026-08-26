import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const n = await prisma.advertisingActionLog.count({ where: { executionId: 'acr3-gale-consolidation-20260805' } })
console.log('action log rows tagged acr3-gale-consolidation-20260805 (executionId):', n)
await prisma.$disconnect()
