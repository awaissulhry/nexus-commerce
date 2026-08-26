import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const m = await prisma.adMutation.findMany({
  where: { entityId: 'cmpsr2j4j01r7ry01lenuh91c' },
  orderBy: { createdAt: 'desc' },
  take: 4,
})
console.dir(m, { depth: 4 })
await prisma.$disconnect()
