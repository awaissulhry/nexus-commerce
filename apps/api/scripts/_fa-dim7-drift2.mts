const { default: prisma } = await import('../src/db.js')
const { resolveIntendedQuantity, resolveMembershipIntended } = await import('../src/services/sync-control-core.js')
const { loadChannelPolicies, policyFor } = await import('../src/services/sync-control-policy.service.js')
const policies = await loadChannelPolicies()

async function ledgerFor(pid: string) {
  const lv = await prisma.stockLevel.findMany({ where: { productId: pid, location: { type: 'WAREHOUSE' } }, select: { available: true, location: { select: { code: true, syncRoutes: true } } } })
  return lv.map((l) => ({ locationCode: l.location!.code, available: l.available, syncRoutes: l.location!.syncRoutes ?? [] }))
}

for (const sku of ['MISANO-JACKET-5XL-BLACK', 'AE-304M-9LSW']) {
  const cl = await prisma.channelListing.findFirst({
    where: { channel: 'AMAZON', marketplace: 'ES', product: { sku } },
    select: { quantity: true, stockBuffer: true, followMasterQuantity: true, syncPaused: true, fulfillmentMethod: true, sourceLocationCodes: true, marketplace: true, channel: true, productId: true, isPublished: true, listingStatus: true, product: { select: { sku: true, fulfillmentMethod: true } } },
  })
  if (!cl) { console.log(sku, 'no ES listing'); continue }
  const led = await ledgerFor(cl.productId)
  const scIsFba = cl.fulfillmentMethod === 'FBA' || cl.product?.fulfillmentMethod === 'FBA'
  const r = resolveIntendedQuantity({
    channel: cl.channel, marketplace: cl.marketplace, isFba: scIsFba, followMasterQuantity: cl.followMasterQuantity,
    syncPaused: cl.syncPaused, pinnedQuantity: cl.quantity, stockBuffer: cl.stockBuffer ?? 0,
    sourceLocationCodes: cl.sourceLocationCodes ?? [], channelPolicy: policyFor(policies, cl.channel, cl.marketplace), ledger: led,
  })
  const intended = r.kind === 'FOLLOW' ? r.quantity : r.kind === 'PINNED' ? r.quantity : null
  console.log(sku, 'ES  SCmode=', r.kind, 'SC intended=', intended, 'SC live(cl.quantity)=', cl.quantity, 'DRIFT shown =', intended != null && cl.quantity != null && intended !== cl.quantity, ' | published/status:', cl.isPublished, cl.listingStatus, 'lfm/pfm', cl.fulfillmentMethod, cl.product?.fulfillmentMethod)
}

// eBay membership drift: readback says eBay shows 62, pool intends 31
const mems = await prisma.sharedListingMembership.findMany({
  where: { sku: 'GALE-JACKET-YELLOW-MEN-XXS', itemId: '257584954808' },
  select: { sku: true, itemId: true, marketplace: true, followPool: true, stockBuffer: true, lastQtyPushed: true, status: true, productId: true },
})
for (const m of mems) {
  const led = m.productId ? await ledgerFor(m.productId) : []
  const r = resolveMembershipIntended({ marketplace: m.marketplace, followPool: m.followPool ?? true, stockBuffer: m.stockBuffer ?? 0, channelPolicy: policyFor(policies, 'EBAY', m.marketplace), ledger: led })
  const intended = r.kind === 'FOLLOW' ? r.quantity : null
  console.log('MEMBERSHIP', m.sku, m.itemId, m.status, 'SCmode=', r.kind, 'intended=', intended, 'SC live(lastQtyPushed)=', m.lastQtyPushed, 'DRIFT shown =', intended != null && m.lastQtyPushed != null && intended !== m.lastQtyPushed, '(readback: eBay actually shows 62)')
}
await prisma.$disconnect()
