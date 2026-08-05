/** READ-ONLY: regions present on eBay listings + familyId-mode bleed check. */
const { default: prisma } = await import('../src/db.js')

const regions = await prisma.channelListing.groupBy({
  by: ['region', 'marketplace'],
  where: { channel: 'EBAY' },
  _count: { _all: true },
})
console.log('eBay listing regions:', JSON.stringify(regions.map((r: any) => ({ region: r.region, marketplace: r.marketplace, n: r._count._all }))))

// products with a DE listing but NO IT listing
const all = await prisma.product.findMany({
  where: { deletedAt: null, channelListings: { some: { channel: 'EBAY' } } },
  select: { id: true, sku: true, parentId: true, channelListings: { where: { channel: 'EBAY' }, select: { region: true } } },
})
const deOnly = all.filter((p: any) => {
  const r = new Set(p.channelListings.map((l: any) => l.region))
  return r.has('DE') && !r.has('IT')
})
console.log('products with DE eBay listing but NO IT eBay listing:', deOnly.length, deOnly.map((p: any) => p.sku))
const nonIt = all.filter((p: any) => !p.channelListings.some((l: any) => l.region === 'IT'))
console.log('products with an eBay listing but NONE in IT:', nonIt.length, nonIt.map((p: any) => `${p.sku}:${[...new Set(p.channelListings.map((l: any) => l.region))].join('/')}`))

// familyId mode for the GALE family under marketplace=DE
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
console.log('GALE-JACKET parent id:', gale?.id)
await prisma.$disconnect()
