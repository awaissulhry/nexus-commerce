// READ-ONLY verification probe
const { default: prisma } = await import('../src/db.js')

// 1) eBay listings per product, grouped by marketplace
const listings = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { productId: true, marketplace: true, syncStatus: true },
})
const byProduct = new Map<string, Set<string>>()
for (const l of listings) {
  if (!byProduct.has(l.productId)) byProduct.set(l.productId, new Set())
  byProduct.get(l.productId)!.add(l.marketplace)
}
const multi = [...byProduct.entries()].filter(([, m]) => m.size > 1)
console.log('eBay ChannelListing rows:', listings.length)
console.log('distinct marketplaces:', [...new Set(listings.map(l => l.marketplace))].join(','))
console.log('products with eBay listings in >1 marketplace:', multi.length)

const ids = multi.map(([pid]) => pid)
if (ids.length) {
  const prods = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, sku: true, parentId: true, isParent: true, imageAxisPreference: true },
  })
  for (const p of prods.slice(0, 25)) {
    console.log(` ${p.sku} parent=${p.isParent} axisPref=${p.imageAxisPreference ?? '-'} markets=${[...byProduct.get(p.id)!].join('/')}`)
  }
}

// 2) how many products have a non-null imageAxisPreference at all
const withPref = await prisma.product.count({ where: { NOT: { imageAxisPreference: null } } })
const prefVals = await prisma.product.groupBy({
  by: ['imageAxisPreference'],
  _count: { _all: true },
  where: { NOT: { imageAxisPreference: null } },
})
console.log('\nproducts with imageAxisPreference set:', withPref)
console.log(prefVals.map(v => `${v.imageAxisPreference} x${v._count._all}`).join(' | '))

// 3) ListingImage scoping for EBAY — is any per-marketplace?
const li = await prisma.listingImage.groupBy({
  by: ['scope', 'platform', 'marketplace'],
  _count: { _all: true },
})
console.log('\nListingImage buckets (scope/platform/marketplace → count):')
for (const r of li) console.log(` ${r.scope}/${r.platform ?? '-'}/${r.marketplace ?? '-'} → ${r._count._all}`)

// 4) eBay ListingImage rows with a variantGroupKey (curated per-axis buckets)
const keys = await prisma.listingImage.groupBy({
  by: ['variantGroupKey'],
  _count: { _all: true },
  where: { platform: 'EBAY' },
})
console.log('\nEBAY variantGroupKey distribution:')
for (const k of keys) console.log(` ${k.variantGroupKey ?? '(null)'} → ${k._count._all}`)

await prisma.$disconnect()
