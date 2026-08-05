/** READ-ONLY: SC.0 shadow diff — the derivation core vs the live system.
 *  With ZERO rules configured (all servesMarketplaces empty, no pauses, no
 *  policies) the core must reproduce current behavior EXACTLY. */
const { default: prisma } = await import('../src/db.js')
const { resolveIntendedQuantity, resolveMembershipIntended } = await import('../src/services/sync-control-core.js')

// rules census — must all be zero/default for the identity claim
const routedLocations = await prisma.stockLocation.count({ where: { NOT: { syncRoutes: { isEmpty: true } } } })
const paused = await prisma.channelListing.count({ where: { syncPaused: true } })
const overrides = await prisma.channelListing.count({ where: { NOT: { sourceLocationCodes: { isEmpty: true } } } })
const excluded = await prisma.sharedListingMembership.count({ where: { followPool: false } })
const policies = await prisma.syncChannelPolicy.count()
console.log(`rules census: routedLocations=${routedLocations} pausedListings=${paused} overrides=${overrides} excludedMemberships=${excluded} policies=${policies}`)

// ledger per product (WAREHOUSE rows + location routing)
const levels = await prisma.stockLevel.findMany({
  where: { location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
})
const ledgerByProduct = new Map<string, { locationCode: string; available: number; syncRoutes: string[] }[]>()
for (const l of levels) {
  const arr = ledgerByProduct.get(l.productId) ?? []
  arr.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] })
  ledgerByProduct.set(l.productId, arr)
}

// Amazon listings (published, non-deleted status)
const listings = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: {
    id: true, marketplace: true, quantity: true, stockBuffer: true, followMasterQuantity: true,
    syncPaused: true, sourceLocationCodes: true, fulfillmentMethod: true, productId: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})
const counts = { FBA_EXCLUDED: 0, PAUSED: 0, UNCOUNTED: 0, PINNED: 0, FOLLOW_MATCH: 0, FOLLOW_DIFF: 0, PINNED_DIFF: 0, FOLLOW_NULL_CURRENT: 0 }
const diffs: string[] = []
for (const cl of listings) {
  const isFba = cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod === null && cl.product?.fulfillmentMethod === 'FBA') || cl.product?.fulfillmentMethod === 'FBA'
  const r = resolveIntendedQuantity({
    channel: 'AMAZON', marketplace: cl.marketplace, isFba,
    followMasterQuantity: cl.followMasterQuantity, syncPaused: cl.syncPaused,
    pinnedQuantity: cl.quantity, stockBuffer: cl.stockBuffer ?? 0,
    sourceLocationCodes: cl.sourceLocationCodes ?? [], channelPolicy: null,
    ledger: ledgerByProduct.get(cl.productId) ?? [],
  })
  if (r.kind === 'FBA_EXCLUDED') counts.FBA_EXCLUDED++
  else if (r.kind === 'PAUSED') counts.PAUSED++
  else if (r.kind === 'UNCOUNTED') counts.UNCOUNTED++
  else if (r.kind === 'PINNED') counts.PINNED++
  else {
    if (cl.quantity === null) counts.FOLLOW_NULL_CURRENT++
    else if (r.quantity === cl.quantity) counts.FOLLOW_MATCH++
    else {
      counts.FOLLOW_DIFF++
      if (diffs.length < 10) diffs.push(`AMZ ${cl.product?.sku}@${cl.marketplace} core=${r.quantity} live=${cl.quantity}`)
    }
  }
}
console.log('== AMAZON listings ==', JSON.stringify(counts))
for (const d of diffs) console.log('  diff: ' + d)

// eBay memberships
const membs = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true, followPool: true, stockBuffer: true, lastQtyPushed: true },
})
const em = { PAUSED: 0, UNCOUNTED: 0, MATCH_LASTPUSH: 0, DIFF_LASTPUSH: 0, NULL_LASTPUSH: 0 }
const ediffs: string[] = []
for (const m of membs) {
  if (!m.productId) continue
  const r = resolveMembershipIntended({
    marketplace: m.marketplace, followPool: m.followPool, stockBuffer: m.stockBuffer ?? 0,
    channelPolicy: null, ledger: ledgerByProduct.get(m.productId) ?? [],
  })
  if (r.kind === 'PAUSED') em.PAUSED++
  else if (r.kind === 'UNCOUNTED') em.UNCOUNTED++
  else if (r.kind === 'FOLLOW') {
    if (m.lastQtyPushed === null) em.NULL_LASTPUSH++
    else if (m.lastQtyPushed === r.quantity) em.MATCH_LASTPUSH++
    else {
      em.DIFF_LASTPUSH++
      if (ediffs.length < 8) ediffs.push(`EBAY ${m.sku}@${m.itemId} core=${r.quantity} lastPushed=${m.lastQtyPushed}`)
    }
  }
}
console.log('== eBay memberships (vs lastQtyPushed — converging set expected) ==', JSON.stringify(em))
for (const d of ediffs) console.log('  ' + d)
await prisma.$disconnect()
process.exit(0)
