/** READ-ONLY: why does SKU 'test'/'TEST' appear in Sync Control but not /products? */
const { default: prisma } = await import('../src/db.js')

const prods = await prisma.product.findMany({
  where: { sku: { in: ['test', 'TEST'] } },
  select: {
    id: true, sku: true, name: true, status: true, parentId: true,
    deletedAt: true, isMaster: true, isMasterProduct: true,
    createdAt: true, updatedAt: true,
  },
})
console.log(`products named test/TEST: ${prods.length}`)
for (const p of prods) {
  console.log(`\n${p.sku}  id=${p.id}`)
  console.log(`  status=${p.status} parentId=${p.parentId ?? 'null'} deletedAt=${p.deletedAt ?? 'null'}`)
  console.log(`  created=${p.createdAt.toISOString()} updated=${p.updatedAt.toISOString()}`)
  const kids = await prisma.product.findMany({ where: { parentId: p.id }, select: { sku: true, status: true, deletedAt: true } })
  console.log(`  children=${kids.length}: ${kids.map((k) => `${k.sku}(${k.status}${k.deletedAt ? ',DELETED' : ''})`).join(', ')}`)
  const ids = [p.id, ...kids.map(() => '')].filter(Boolean)
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: [p.id] } },
    select: { id: true, channel: true, marketplace: true, isPublished: true, listingStatus: true, externalListingId: true },
  })
  console.log(`  channelListings=${cls.length}`)
  for (const c of cls) console.log(`    ${c.channel}:${c.marketplace} published=${c.isPublished} status=${c.listingStatus} ext=${c.externalListingId ?? '-'}`)
  const mem = await prisma.sharedListingMembership.findMany({ where: { productId: p.id }, select: { itemId: true, status: true, sku: true } })
  console.log(`  memberships=${mem.length}: ${mem.map((m) => `${m.sku}@${m.itemId}(${m.status})`).join(', ')}`)
}

// Children of those masters may carry the listings
for (const p of prods) {
  const kids = await prisma.product.findMany({ where: { parentId: p.id }, select: { id: true, sku: true, status: true, deletedAt: true } })
  if (!kids.length) continue
  const kidCls = await prisma.channelListing.findMany({
    where: { productId: { in: kids.map((k) => k.id) } },
    select: { channel: true, marketplace: true, isPublished: true, listingStatus: true, product: { select: { sku: true, status: true, deletedAt: true } } },
  })
  console.log(`\n${p.sku} CHILD listings: ${kidCls.length}`)
  for (const c of kidCls) console.log(`    ${c.product?.sku} ${c.channel}:${c.marketplace} published=${c.isPublished} status=${c.listingStatus} prodStatus=${c.product?.status} deleted=${c.product?.deletedAt ?? '-'}`)
}
await prisma.$disconnect()
