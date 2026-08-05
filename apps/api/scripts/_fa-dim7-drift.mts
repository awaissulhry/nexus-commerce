const { default: prisma } = await import('../src/db.js')
const hl = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_QTY_READBACK' },
  select: { productId: true, errorMessage: true, createdAt: true, channel: true, resolutionStatus: true },
  orderBy: { createdAt: 'desc' }, take: 10,
})
console.log('CHANNEL_QTY_READBACK logs (latest 10):', hl.length)
for (const h of hl) console.log(h.createdAt.toISOString(), h.channel, h.resolutionStatus, (h.errorMessage ?? '').slice(0, 130))

// For any product with an UNRESOLVED readback mismatch, what does SC's drift say?
const un = hl.filter((h) => h.resolutionStatus === 'UNRESOLVED')
for (const h of un.slice(0, 5)) {
  const cls = await prisma.channelListing.findMany({
    where: { productId: h.productId!, channel: 'AMAZON' },
    select: { marketplace: true, quantity: true, followMasterQuantity: true, syncPaused: true, fulfillmentMethod: true, product: { select: { sku: true, fulfillmentMethod: true } } },
  })
  console.log('  product', cls[0]?.product?.sku, JSON.stringify(cls))
}
await prisma.$disconnect()
