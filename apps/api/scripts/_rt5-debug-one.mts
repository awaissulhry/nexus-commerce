/** Debug: one tiny follow-apply, full visibility. */
const { default: prisma } = await import('../src/db.js')
const { setFollowMasterQuantity } = await import('../src/services/follow-master.service.js')

const two = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', followMasterQuantity: false, listingStatus: { not: 'ENDED' }, fulfillmentMethod: 'FBM' },
  select: { productId: true, marketplace: true, quantity: true, quantityOverride: true, product: { select: { sku: true } } },
  take: 2,
})
console.log('before:', JSON.stringify(two.map((l) => ({ sku: l.product?.sku, mp: l.marketplace, q: l.quantity, qo: l.quantityOverride }))))
const ids = [...new Set(two.map((l) => l.productId))]
try {
  const res = await setFollowMasterQuantity({ productIds: ids, channel: 'AMAZON', markets: 'ALL', follow: true, actor: 'rt5-debug' })
  console.log('service result:', JSON.stringify({ matched: res.matched, updated: res.updated, skippedFba: res.skippedFba, unchanged: res.unchanged }))
  console.log('per-listing:', JSON.stringify(res.results?.slice(0, 6) ?? []))
} catch (err) {
  console.log('SERVICE THREW:', err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 4).join('\n')}` : String(err))
}
const after = await prisma.channelListing.findMany({
  where: { productId: { in: ids }, channel: 'AMAZON' },
  select: { marketplace: true, followMasterQuantity: true, quantity: true, quantityOverride: true, product: { select: { sku: true } } },
})
console.log('after:', JSON.stringify(after.map((l) => ({ sku: l.product?.sku, mp: l.marketplace, follow: l.followMasterQuantity, q: l.quantity }))))
await prisma.$disconnect()
process.exit(0)
