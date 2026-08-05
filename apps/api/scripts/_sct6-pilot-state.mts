/** READ-ONLY: pilot state — the closed row's DB record + queue cancellations. */
const { default: prisma } = await import('../src/db.js')
const cl = await prisma.channelListing.findFirst({
  where: { channel: 'AMAZON', marketplace: 'DE', product: { sku: 'REGAL-JACKET-3XL-GREY-MEN' } },
  select: { offerClosedAt: true, offerClosedBy: true, offerCloseSnapshot: true, followMasterQuantity: true },
})
console.log('DE row:', JSON.stringify({
  closedAt: cl?.offerClosedAt, by: cl?.offerClosedBy,
  snapshotKeys: cl?.offerCloseSnapshot ? Object.keys(cl.offerCloseSnapshot as object) : null,
  snapshotSource: (cl?.offerCloseSnapshot as any)?.snapshotSource,
  offer: JSON.stringify((cl?.offerCloseSnapshot as any)?.purchasableOffer)?.slice(0, 220),
}, null, 1))
await prisma.$disconnect()
