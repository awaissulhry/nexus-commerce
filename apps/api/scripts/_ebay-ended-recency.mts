/** READ-ONLY: how recent are the 'scaduta'-ended memberships? (D9 urgency) */
const { default: prisma } = await import('../src/db.js')
const ended = await prisma.sharedListingMembership.findMany({
  where: { status: 'ENDED', lastError: { contains: 'scaduta' } },
  select: { updatedAt: true, sku: true, itemId: true },
  orderBy: { updatedAt: 'desc' },
})
const now = Date.now()
const within = (h: number) => ended.filter(e => now - e.updatedAt.getTime() < h*3600e3).length
console.log(`'scaduta'-ended memberships: total=${ended.length}`)
console.log(`  last 24h=${within(24)}  last 7d=${within(24*7)}  last 30d=${within(24*30)}`)
console.log(`  newest: ${ended[0]?.updatedAt.toISOString()} (${ended[0]?.sku})`)
console.log(`  oldest: ${ended[ended.length-1]?.updatedAt.toISOString()}`)
// distinct items affected
console.log(`  distinct itemIds affected: ${new Set(ended.map(e=>e.itemId)).size}`)
await prisma.$disconnect()
