const { default: prisma } = await import('../src/db.js')
// masters = products with no parent that have listings or children
const masters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true } })
let rows: any[] = []
for (const m of masters) {
  const variants = await prisma.product.findMany({ where: { OR: [{ id: m.id }, { parentId: m.id }] }, select: { id: true } })
  const pids = variants.map(v => v.id)
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
    select: { productId: true, fulfillmentMethod: true, product: { select: { fulfillmentMethod: true } } },
  })
  const mems = await prisma.sharedListingMembership.count({ where: { productId: { in: pids }, status: 'ACTIVE' } })
  const fba = cls.filter(c => c.fulfillmentMethod === 'FBA' || (c.fulfillmentMethod == null && c.product?.fulfillmentMethod === 'FBA') || c.product?.fulfillmentMethod === 'FBA').length
  if (cls.length || mems) rows.push({ sku: m.sku, listings: cls.length, fba, mems })
}
rows.sort((a,b)=>b.fba-a.fba)
console.log('MASTERS with targets:', rows.length)
console.log('with fba>0:', rows.filter(r=>r.fba>0).length)
console.table(rows.slice(0,15))
await prisma.$disconnect()
