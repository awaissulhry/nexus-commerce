/** READ-ONLY: size the eBay inconsistency classes. */
const { default: prisma } = await import('../src/db.js')
const unlinked = await prisma.sharedListingMembership.groupBy({
  by: ['itemId'],
  where: { status: 'ACTIVE', productId: null },
  _count: true,
})
const totUnlinked = unlinked.reduce((s, u) => s + u._count, 0)
console.log(`ACTIVE memberships with productId=null: ${totUnlinked} across ${unlinked.length} listings`)
for (const u of unlinked.slice(0, 8)) console.log(`  item ${u.itemId}: ${u._count}`)

for (const sku of ['WATERPROOF-OVERJACKET-BLACK-MEN-XS', 'WATERPROOF-OVERJACKET-BLACK-MEN-3XL', 'VENTRA-JACKET-4XL-YELLOW-MEN']) {
  const m = await prisma.sharedListingMembership.findFirst({ where: { sku }, select: { productId: true, itemId: true } })
  const p = m?.productId
    ? await prisma.product.findUnique({ where: { id: m.productId }, select: { sku: true, totalStock: true } })
    : null
  console.log(`${sku}: membershipProduct=${m?.productId ?? 'NULL'} poolStock=${p?.totalStock ?? '-'}`)
}
const zeroOver = await prisma.syncHealthLog.count({
  where: {
    channel: 'EBAY',
    conflictType: 'CHANNEL_QTY_READBACK',
    createdAt: { gte: new Date(Date.now() - 24 * 3600e3) },
    errorMessage: { contains: 'pool intends 0' },
  },
})
console.log(`flagged pool-0-but-ebay-positive rows (24h): ${zeroOver}`)
await prisma.$disconnect()
process.exit(0)
