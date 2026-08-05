// READ-ONLY verification probe 2
const { default: prisma } = await import('../src/db.js')

const prefs = await prisma.product.findMany({
  where: { NOT: { imageAxisPreference: null } },
  select: { id: true, sku: true, isParent: true, parentId: true, imageAxisPreference: true, variationTheme: true },
})
console.log('Products with imageAxisPreference:')
for (const p of prefs) {
  const cls = await prisma.channelListing.findMany({
    where: { productId: p.id, channel: 'EBAY' },
    select: { marketplace: true, externalListingId: true, isPublished: true, syncStatus: true },
  })
  const kids = await prisma.product.count({ where: { parentId: p.id } })
  console.log(` ${p.sku} pref=${p.imageAxisPreference} isParent=${p.isParent} kids=${kids} theme=${p.variationTheme ?? '-'}`)
  for (const c of cls) console.log(`    listing ${c.marketplace} published=${c.isPublished} sync=${c.syncStatus} ext=${c.externalListingId ?? '-'}`)
}

// WATERPROOF parent: eBay listings in both markets — state
const wp = await prisma.product.findFirst({
  where: { sku: 'WATERPROOF-OVERJACKET-BLACK-MEN' },
  select: { id: true, sku: true, imageAxisPreference: true, variationTheme: true },
})
console.log('\nWATERPROOF parent:', JSON.stringify(wp))
if (wp) {
  const cls = await prisma.channelListing.findMany({
    where: { productId: wp.id, channel: 'EBAY' },
    select: { marketplace: true, externalListingId: true, isPublished: true, syncStatus: true, platformAttributes: true },
  })
  for (const c of cls) {
    const pa = (c.platformAttributes ?? {}) as Record<string, unknown>
    console.log(`  ${c.marketplace} published=${c.isPublished} sync=${c.syncStatus} ext=${c.externalListingId ?? '-'} _variationAxes=${JSON.stringify(pa._variationAxes)} _axisNameLabels=${JSON.stringify(pa._axisNameLabels)} _imageAxis=${JSON.stringify((pa as any)._imageAxis)}`)
  }
  const imgs = await prisma.listingImage.groupBy({
    by: ['scope', 'platform', 'marketplace', 'variantGroupKey', 'variantGroupValue'],
    _count: { _all: true },
    where: { productId: wp.id },
  })
  console.log('  ListingImage buckets for WATERPROOF parent:', imgs.length)
  for (const i of imgs) console.log(`   ${i.scope}/${i.platform}/${i.marketplace ?? '-'} key=${i.variantGroupKey ?? '-'} val=${i.variantGroupValue ?? '-'} n=${i._count._all}`)
}

// Does any ChannelListing.platformAttributes already carry a per-market image axis key?
const anyPa = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { marketplace: true, platformAttributes: true, productId: true },
})
const keys = new Set<string>()
for (const c of anyPa) {
  const pa = (c.platformAttributes ?? {}) as Record<string, unknown>
  for (const k of Object.keys(pa)) if (k.startsWith('_')) keys.add(k)
}
console.log('\nunderscore keys seen in eBay platformAttributes:', [...keys].join(', '))

await prisma.$disconnect()
