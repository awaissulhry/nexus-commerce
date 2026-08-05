/** DIM6: replicate computeRows() and compare the three surfaces. Read-only. */
const { default: prisma } = await import('../src/db.js')
const { resolveIntendedQuantity, resolveMembershipIntended } = await import('../src/services/sync-control-core.js')
const { loadChannelPolicies, policyFor } = await import('../src/services/sync-control-policy.service.js')
const { summarizeProductSync } = await import('../src/services/sync-control-product-view.js')

const [listings, memberships, policies] = await Promise.all([
  prisma.channelListing.findMany({
    where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: {
      productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
      followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true,
      product: { select: { sku: true, fulfillmentMethod: true } },
    },
  }),
  prisma.sharedListingMembership.findMany({
    where: { status: 'ACTIVE' },
    select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true },
  }),
  loadChannelPolicies(),
])
const productIds = [...new Set([...listings.map((l) => l.productId), ...memberships.map((m) => m.productId).filter(Boolean) as string[]])]
const levels = await prisma.stockLevel.findMany({
  where: { productId: { in: productIds }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
})
const ledgers = new Map<string, any[]>()
for (const l of levels) {
  const a = ledgers.get(l.productId) ?? []
  a.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] })
  ledgers.set(l.productId, a)
}
const modeOf = (r: any, shared: boolean) => r.kind === 'FBA_EXCLUDED' ? 'FBA'
  : r.kind === 'PAUSED' ? (r.via === 'POLICY' ? 'PAUSED_POLICY' : shared ? 'EXCLUDED' : 'PAUSED')
  : r.kind
const rows: any[] = []
for (const cl of listings) {
  const isFba = cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') || cl.product?.fulfillmentMethod === 'FBA'
  const r = resolveIntendedQuantity({
    channel: cl.channel, marketplace: cl.marketplace, isFba, followMasterQuantity: cl.followMasterQuantity,
    syncPaused: cl.syncPaused, pinnedQuantity: cl.quantity, stockBuffer: cl.stockBuffer ?? 0,
    sourceLocationCodes: cl.sourceLocationCodes ?? [], channelPolicy: policyFor(policies, cl.channel, cl.marketplace),
    ledger: ledgers.get(cl.productId) ?? [],
  } as any)
  rows.push({ lane: 'LISTING', sku: cl.product?.sku ?? '?', productId: cl.productId, channel: cl.channel, marketplace: cl.marketplace,
    mode: modeOf(r, false), intendedQty: (r as any).quantity ?? null, liveQty: cl.quantity, buffer: cl.stockBuffer ?? 0, routedLocations: (r as any).routedLocations ?? [] })
}
for (const m of memberships) {
  const r = resolveMembershipIntended({ marketplace: m.marketplace, followPool: m.followPool ?? true, stockBuffer: m.stockBuffer ?? 0,
    channelPolicy: policyFor(policies, 'EBAY', m.marketplace), ledger: m.productId ? (ledgers.get(m.productId) ?? []) : [] } as any)
  rows.push({ lane: 'SHARED', sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace,
    mode: modeOf(r, true), intendedQty: (r as any).quantity ?? null, liveQty: m.lastQtyPushed, buffer: m.stockBuffer ?? 0, routedLocations: (r as any).routedLocations ?? [], itemId: m.itemId })
}
const byMode: Record<string, number> = {}
for (const r of rows) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1
console.log('OVERVIEW summary.byMode (what the tiles show):', byMode)
console.log('tile "Paused" =', (byMode.PAUSED ?? 0) + (byMode.PAUSED_POLICY ?? 0) + (byMode.EXCLUDED ?? 0))
console.log('total rows', rows.length)

// group by master → rollup, top 5 by listings
const rp = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true, sku: true } })
const masterOf = new Map(rp.map((p) => [p.id, p.parentId ?? p.id]))
const byMaster = new Map<string, any[]>()
for (const r of rows) { if (!r.productId) continue; const k = masterOf.get(r.productId) ?? r.productId; const a = byMaster.get(k) ?? []; a.push(r); byMaster.set(k, a) }
const tops = [...byMaster.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5)
const names = await prisma.product.findMany({ where: { id: { in: tops.map((t) => t[0]) } }, select: { id: true, sku: true } })
const skuById = new Map(names.map((n) => [n.id, n.sku]))
for (const [mid, kids] of tops) {
  const roll = summarizeProductSync(kids)
  console.log(`\nmaster ${skuById.get(mid)} (${mid}) listings=${kids.length} drift=${roll.driftCount}`)
  console.log('  modeCounts:', roll.modeCounts)
}
await prisma.$disconnect()
