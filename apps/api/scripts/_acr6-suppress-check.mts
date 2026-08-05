import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const low = await prisma.adTarget.count({ where: { bidCents: { lt: 5 }, status: 'ENABLED', isNegative: false } })
const marked = await prisma.adTarget.count({ where: { bidCents: { lt: 5 }, status: 'ENABLED', isNegative: false, suppressedFromBidCents: { not: null } } })
const anyMarked = await prisma.adTarget.count({ where: { suppressedFromBidCents: { not: null } } })
console.log(`  ENABLED non-negative targets with bid < 5c: ${low}`)
console.log(`  ...of which carry suppressedFromBidCents:   ${marked}`)
console.log(`  targets carrying the marker at all:         ${anyMarked}`)
await prisma.$disconnect()
