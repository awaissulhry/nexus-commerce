import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// What are the FIRST 12 rows of the GALE group, in the exact order computeRows()
// builds them (listings findMany order, then memberships findMany order)?
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, product: { select: { sku: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' }, select: { sku: true, itemId: true, marketplace: true, productId: true },
})
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true } })
const kids = await prisma.product.findMany({ where: { parentId: gale!.id }, select: { id: true } })
const dupSkus = ['IT-GALE-JACKET', 'GALE-JACKET-ALT1', 'GALE-JACKET-ALT2', 'GALE-JACKET-ALT3']
const dups = await prisma.product.findMany({ where: { sku: { in: dupSkus } }, select: { id: true } })
const group = new Set([gale!.id, ...kids.map(k => k.id), ...dups.map(d => d.id)])

const rows: string[] = []
for (const l of listings) if (group.has(l.productId)) rows.push(`LISTING ${l.product?.sku}  ${l.channel}/${l.marketplace}`)
for (const m of mems) if (m.productId && group.has(m.productId)) rows.push(`SHARED  ${m.sku}  EBAY/${m.marketplace} #${m.itemId}`)
console.log('GALE group total rows:', rows.length)
console.log('--- the 12 rows the grid previews (children.slice(0,12), no sort) ---')
rows.slice(0, 12).forEach((r, i) => console.log(' ', String(i + 1).padStart(2), r))
console.log('--- sorted-by-sku equivalent (what the detail page shows first) ---')
;[...rows].sort().slice(0, 12).forEach((r, i) => console.log(' ', String(i + 1).padStart(2), r))

// stability of the underlying unordered scans across repeated calls
const a = (await prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { id: true } })).map(x => x.id).join(',')
const b = (await prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { id: true } })).map(x => x.id).join(',')
console.log('\nunordered channelListing scan identical across 2 calls:', a === b)

await prisma.$disconnect()
