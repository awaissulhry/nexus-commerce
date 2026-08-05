const { default: prisma } = await import('../src/db.js')
const rows = await prisma.sharedListingMembership.groupBy({ by: ['marketplace'], _count: { _all: true } })
console.log(JSON.stringify(rows))
await prisma.$disconnect()
