import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// GALE canonical
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, sku: true } })
if (!gale) throw new Error('no GALE')
const dupSkus = ['IT-GALE-JACKET', 'GALE-JACKET-ALT1', 'GALE-JACKET-ALT2', 'GALE-JACKET-ALT3']
const dups = await prisma.product.findMany({ where: { sku: { in: dupSkus } }, select: { id: true, sku: true } })

// what the products endpoint children include for the GALE group:
const kids = await prisma.product.findMany({ where: { parentId: gale.id }, select: { id: true } })
const canonicalPids = new Set([gale.id, ...kids.map(k => k.id)])
const dupIds = dups.map(d => d.id)

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, productId: { in: [...canonicalPids, ...dupIds] } },
  select: { productId: true, channel: true, marketplace: true },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE', productId: { in: [...canonicalPids, ...dupIds] } },
  select: { productId: true, sku: true, itemId: true },
})
const inGroupTotal = listings.length + mems.length
const exportScope = listings.filter(l => canonicalPids.has(l.productId)).length + mems.filter(m => m.productId && canonicalPids.has(m.productId)).length
console.log('GALE group rows shown by /products?masterId=', inGroupTotal)
console.log('GALE rows the /export?masterId= filter would emit  =', exportScope)
console.log('MISSING from export =', inGroupTotal - exportScope)
console.log('missing rows (duplicate-master LISTING rows):')
for (const l of listings.filter(l => !canonicalPids.has(l.productId))) {
  console.log('  ', dups.find(d => d.id === l.productId)?.sku, l.channel, l.marketplace)
}

// deep-link check: does /products?masterId=<dup> return anything now?
console.log('\nfolded member master ids (deep links that now 404):')
for (const d of dups) console.log('  /fulfillment/stock/sync-control/product/' + d.id, d.sku)
await prisma.$disconnect()
