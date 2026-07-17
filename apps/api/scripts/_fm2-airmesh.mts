import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
const FAM='cmonjewg10001o701j5cqpfzs'
const prods = await prisma.product.findMany({
  where: { OR: [{ id: FAM }, { parentId: FAM }] },
  select: { id: true, sku: true, parentId: true, totalStock: true,
    stockLevels: { where: { location: { type: 'WAREHOUSE' } }, select: { quantity: true } },
    channelListings: { where: { channel: 'EBAY', marketplace: 'IT', listingStatus: { not: 'ENDED' } }, select: { id: true, quantity: true, quantityOverride: true, followMasterQuantity: true, listingStatus: true } } },
  orderBy: { sku: 'asc' },
})
console.log('AIRMESH family: parent + %d rows', prods.length)
for (const p of prods) {
  const wh = p.stockLevels.reduce((a,s)=>a+s.quantity,0)
  const cl = p.channelListings[0]
  console.log(`${p.sku} | ${p.parentId?'child':'PARENT'} | pool(totalStock=${p.totalStock},wh=${wh}) | eBayIT=${cl?`{id:${cl.id.slice(-6)},qty:${cl.quantity},ovr:${cl.quantityOverride},follow:${cl.followMasterQuantity},${cl.listingStatus}}`:'none'}`)
}
await prisma.$disconnect(); process.exit(0)
