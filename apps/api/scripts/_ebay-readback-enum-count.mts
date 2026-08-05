/** FAST: how many products would the read-back cron sweep? (enumeration only,
 * no GetItem loop — refreshEbayLiveImages itself is already verified in 2A). */
const { default: prisma } = await import('../src/db.js')

const [withItemId, memberParents] = await Promise.all([
  prisma.product.findMany({
    where: { ebayItemId: { not: null }, deletedAt: null, OR: [{ isParent: true }, { parentId: null }] },
    select: { id: true },
  }),
  prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { parentSku: true }, distinct: ['parentSku'] }),
])
const parentSkus = memberParents.map((m) => m.parentSku).filter((s): s is string => !!s)
const parents = parentSkus.length
  ? await prisma.product.findMany({ where: { sku: { in: parentSkus }, deletedAt: null }, select: { id: true } })
  : []
const ids = new Set([...withItemId.map((p) => p.id), ...parents.map((p) => p.id)])

// For comparison: the OLD (over-broad) count = every product with an ebayItemId.
const oldBroad = await prisma.product.count({ where: { ebayItemId: { not: null }, deletedAt: null } })

console.log('withItemId (parents/standalone):', withItemId.length)
console.log('distinct membership parentSkus:', parentSkus.length, '→ resolved products:', parents.length)
console.log('REFINED sweep size (union):', ids.size)
console.log('OLD broad count (all ebayItemId products):', oldBroad)
await prisma.$disconnect()
