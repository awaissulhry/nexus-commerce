// READ-ONLY: map the multi-listing (shell) model + curated eBay images state.
const { default: prisma } = await import('../src/db.js')

const shells = await prisma.product.findMany({
  where: { productType: 'EBAY_LISTING_SHELL', deletedAt: null },
  select: { id: true, sku: true, name: true, isParent: true, parentId: true, imageAxisPreference: true },
})
console.log(`Shells: ${shells.length}`)
for (const s of shells) {
  const memberships = await prisma.sharedListingMembership.findMany({
    where: { parentSku: s.sku ?? '' },
    select: { itemId: true, marketplace: true, sku: true, status: true },
  })
  const items = [...new Set(memberships.map((m) => `${m.marketplace}:${m.itemId}`))]
  const li = await prisma.listingImage.groupBy({
    by: ['variantGroupKey', 'variantGroupValue'],
    where: { productId: s.id, platform: 'EBAY' },
    _count: true,
  })
  const cl = await prisma.channelListing.findMany({
    where: { productId: s.id, channel: 'EBAY' },
    select: { region: true, platformAttributes: true },
  })
  console.log(`\n■ ${s.sku} (${s.id}) axisPref=${s.imageAxisPreference ?? '-'}`)
  console.log(`  memberships: ${memberships.length} (${memberships.filter((m) => m.status === 'ACTIVE').length} active) items: ${items.join(', ')}`)
  console.log(`  channelListings: ${cl.map((c) => `${c.region} itemId=${(c.platformAttributes as any)?.ebayItemId ?? '-'}`).join(' | ')}`)
  console.log(`  curated eBay ListingImage buckets: ${li.length === 0 ? 'NONE' : li.map((b) => `${b.variantGroupKey ?? 'shared'}=${b.variantGroupValue ?? '-'}·${b._count}`).join(', ')}`)
}

// The primary family for comparison (GALE-JACKET real parent)
const primary = await prisma.product.findFirst({
  where: { sku: 'GALE-JACKET' },
  select: { id: true, sku: true, productType: true, imageAxisPreference: true },
})
if (primary) {
  const li = await prisma.listingImage.groupBy({
    by: ['variantGroupKey', 'variantGroupValue'],
    where: { productId: primary.id, platform: 'EBAY' },
    _count: true,
  })
  const kids = await prisma.product.count({ where: { parentId: primary.id, deletedAt: null } })
  console.log(`\n■ PRIMARY ${primary.sku} (${primary.id}) type=${primary.productType} children=${kids} axisPref=${primary.imageAxisPreference ?? '-'}`)
  console.log(`  curated eBay buckets: ${li.length === 0 ? 'NONE' : li.map((b) => `${b.variantGroupKey ?? 'shared'}=${b.variantGroupValue ?? '-'}·${b._count}`).join(', ')}`)
}
await prisma.$disconnect()
process.exit(0)
