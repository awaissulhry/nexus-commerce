/** READ-ONLY: are the 25604 'SKU not found' rows covered by the SHARED lane
 *  (Trading itemId memberships) — i.e. harmless parent-row noise? */
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 25 * 60 * 1000)
const failed = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', targetChannel: 'EBAY', createdAt: { gte: since }, syncStatus: 'FAILED', errorMessage: { contains: '25604' } },
  select: { productId: true, product: { select: { sku: true, parentId: true } } },
  distinct: ['productId'],
})
console.log(`distinct products behind 25604 failures: ${failed.length}`)
let covered = 0, uncovered: string[] = []
for (const f of failed) {
  // the product itself or its CHILDREN carry the shared memberships
  const kids = await prisma.product.findMany({ where: { parentId: f.productId }, select: { id: true } })
  const ids = [f.productId, ...kids.map((k) => k.id)]
  const mems = await prisma.sharedListingMembership.count({ where: { productId: { in: ids }, status: 'ACTIVE' } })
  const isParent = kids.length > 0 || !f.product?.parentId
  if (mems > 0) covered++
  else uncovered.push(`${f.product?.sku} (parent=${isParent}, mems=0)`)
}
console.log(`covered by ACTIVE shared memberships (real Trading lane): ${covered}`)
console.log(`NOT covered: ${uncovered.length}`)
for (const u of uncovered.slice(0, 8)) console.log(`   ${u}`)
await prisma.$disconnect()
