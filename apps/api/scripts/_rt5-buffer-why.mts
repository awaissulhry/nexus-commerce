/** Why zero buffer candidates? Distribution check. */
const { default: prisma } = await import('../src/db.js')
const pools = await prisma.stockLevel.groupBy({ by: ['productId'], where: { location: { type: 'WAREHOUSE' } }, _sum: { available: true } })
const small = pools.filter((p) => (p._sum.available ?? 0) >= 1 && (p._sum.available ?? 0) <= 3).map((p) => p.productId)
const active = await prisma.channelListing.findMany({ where: { listingStatus: 'ACTIVE' }, select: { productId: true, channel: true } })
const chBy = new Map<string, Set<string>>()
for (const l of active) { const s = chBy.get(l.productId) ?? new Set(); s.add(l.channel); chBy.set(l.productId, s) }
const multi = small.filter((id) => (chBy.get(id)?.size ?? 0) >= 2)
console.log(`pool 1-3 products: ${small.length}; of those with ≥2 ACTIVE channels: ${multi.length}`)
const anyMulti = [...chBy.entries()].filter(([, s]) => s.size >= 2).length
console.log(`products with ≥2 ACTIVE channels overall: ${anyMulti}`)
await prisma.$disconnect()
process.exit(0)
