import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { canonicalStem } = await import('../src/services/sync-control-product-view.js')

const [listings, memberships] = await Promise.all([
  prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true } }),
  prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } }),
])
const rowPids = [...new Set([...listings.map(l => l.productId), ...memberships.map(m => m.productId).filter((x): x is string => Boolean(x))])]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterIds = [...new Set(rowProducts.map(p => p.parentId ?? p.id))]
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const mastersWithChildren = new Set(withChildren.map(p => p.parentId!).filter(Boolean))
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })

const byStem = new Map<string, string[]>()
for (const m of masterSkus) {
  if (!mastersWithChildren.has(m.id)) continue
  const s = canonicalStem(m.sku)
  const a = byStem.get(s) ?? []; a.push(`${m.sku}(${m.id})`); byStem.set(s, a)
}
console.log('RESULT child-owning masters sharing a stem (nondeterministic canonical):')
let any = false
for (const [s, arr] of byStem) if (arr.length > 1) { any = true; console.log(`  DUPSTEM ${s}: ${arr.join(' , ')}`) }
if (!any) console.log('  none')

// stem of every childless master, and which stems have NO child-owning canonical
console.log('\nRESULT stems of childless masters:')
for (const m of masterSkus) {
  if (mastersWithChildren.has(m.id)) continue
  const s = canonicalStem(m.sku)
  console.log(`  CHILDLESS ${m.sku} stem=${s} canonicalExists=${byStem.has(s)}`)
}
await prisma.$disconnect()
