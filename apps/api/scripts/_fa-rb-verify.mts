const { default: prisma } = await import('../src/db.js')
const logs = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED' },
  select: { id: true, channel: true, productId: true, errorMessage: true, createdAt: true, conflictData: true },
  orderBy: { createdAt: 'desc' }, take: 30,
})
console.log('UNRESOLVED readback logs:', logs.length)
for (const l of logs) console.log(l.createdAt.toISOString(), l.channel, l.productId, JSON.stringify(l.errorMessage)+JSON.stringify(l.conflictData).slice(0,260))
// for each product, dump memberships + channel listings
const pids = [...new Set(logs.map(l=>l.productId).filter(Boolean))] as string[]
const mems = await prisma.sharedListingMembership.findMany({ where: { productId: { in: pids } }, select: { sku:true,itemId:true,marketplace:true,productId:true,lastQtyPushed:true,lastPushedAt:true,status:true,followPool:true } })
console.log('\nMEMBERSHIPS')
for (const m of mems) console.log(m.sku, m.itemId, m.marketplace, 'lastQtyPushed=', m.lastQtyPushed, 'lastPushedAt=', m.lastPushedAt?.toISOString(), m.status, 'followPool=', m.followPool)
const cls = await prisma.channelListing.findMany({ where: { productId: { in: pids } }, select: { productId:true, channel:true, marketplace:true, quantity:true, syncPaused:true, followMasterQuantity:true, isPublished:true, listingStatus:true, product:{select:{sku:true}} } })
console.log('\nLISTINGS')
for (const c of cls) console.log(c.product?.sku, c.channel, c.marketplace, 'qty=', c.quantity, 'paused=', c.syncPaused, 'follow=', c.followMasterQuantity, c.isPublished, c.listingStatus)
const lvl = await prisma.stockLevel.findMany({ where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } }, select: { productId:true, available:true, location:{select:{code:true,syncRoutes:true}} } })
console.log('\nSTOCK'); for (const l of lvl) console.log(l.productId, l.location?.code, l.available, l.location?.syncRoutes)
process.exit(0)
