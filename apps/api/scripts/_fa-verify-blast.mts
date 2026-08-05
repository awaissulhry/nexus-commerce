const { default: prisma } = await import('../src/db.js')
const ids = ['cmokmy2mq005lpm0p67d3e7z4','cmokmy3bb007bpm0phlfs27ij','cmokmy179001tpm0pz84dp6nf','cmokmy2qe005tpm0p91cfue2a']
for (const id of ids) {
  const p = await prisma.product.findUnique({ where: { id }, select: { id:true, sku:true, parentId:true, totalStock:true, fulfillmentMethod:true,
    channelListings: { select: { channel:true, marketplace:true, quantity:true, followMasterQuantity:true, syncPaused:true, listingStatus:true, isPublished:true, externalListingId:true, fulfillmentMethod:true, lastSyncStatus:true, lastSyncedAt:true } },
    stockLevels: { select: { quantity:true, available:true, location:{ select:{ code:true, type:true } } } } } })
  console.log('P', JSON.stringify(p))
}
// how many of the 2026-07-20 zero pushes were EBAY with an itemId that has ACTIVE memberships
const ebay = await prisma.$queryRawUnsafe<any[]>(`
  SELECT DISTINCT "externalListingId" FROM "OutboundSyncQueue"
  WHERE payload->>'source'='STOCK_MOVEMENT' AND payload->>'quantity'='0'
    AND payload->'oldQuantity'='null'::jsonb AND "targetChannel"='EBAY' AND "externalListingId" IS NOT NULL`)
for (const e of ebay) {
  const n = await prisma.sharedListingMembership.count({ where: { itemId: e.externalListingId, status: 'ACTIVE' } })
  console.log('EBAYITEM', e.externalListingId, 'activeMemberships', n)
}
await prisma.$disconnect()
