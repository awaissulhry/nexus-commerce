const { default: prisma } = await import('../src/db.js')
const { resolveIntendedQuantity, resolveMembershipIntended } = await import('../src/services/sync-control-core.js')
const { loadChannelPolicies, policyFor } = await import('../src/services/sync-control-policy.service.js')
const { summarizeFamilies, familyKeyOf, summarizeProductSync } = await import('../src/services/sync-control-product-view.js')

const GID = process.argv[2] ?? 'cmokmy3a40078pm0p1fvnu523' // GALE-JACKET
const members = ['cmrp2jfyd0008pa01t3w6mi4h','cmrp2jg640009pa01kq6iitx4','cmrp2jgdw000apa01njru02tp','cmrp2jglx000bpa01arrdhywq']
const kids = await prisma.product.findMany({ where: { parentId: GID }, select: { id: true } })
const pids = [GID, ...members, ...kids.map(k=>k.id)]

const policies = await loadChannelPolicies()
const levels = await prisma.stockLevel.findMany({ where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } } })
const ledgers = new Map<string, any[]>()
for (const l of levels) { const a = ledgers.get(l.productId) ?? []; a.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] }); ledgers.set(l.productId, a) }

const listings = await prisma.channelListing.findMany({ where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } }, select: { productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true, followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true, product: { select: { sku: true, fulfillmentMethod: true } } } })
const mems = await prisma.sharedListingMembership.findMany({ where: { productId: { in: pids }, status: 'ACTIVE' }, select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true } })

const modeOf = (r: any, shared: boolean) => r.kind === 'FBA_EXCLUDED' ? 'FBA' : r.kind === 'PAUSED' ? (r.via === 'POLICY' ? 'PAUSED_POLICY' : shared ? 'EXCLUDED' : 'PAUSED') : r.kind
const rows: any[] = []
for (const cl of listings) {
  const isFba = cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') || cl.product?.fulfillmentMethod === 'FBA'
  const r = resolveIntendedQuantity({ channel: cl.channel, marketplace: cl.marketplace, isFba, followMasterQuantity: cl.followMasterQuantity, syncPaused: cl.syncPaused, pinnedQuantity: cl.quantity, stockBuffer: cl.stockBuffer ?? 0, sourceLocationCodes: cl.sourceLocationCodes ?? [], channelPolicy: policyFor(policies, cl.channel, cl.marketplace), ledger: ledgers.get(cl.productId) ?? [] } as any)
  rows.push({ lane: 'LISTING', sku: cl.product?.sku ?? '?', productId: cl.productId, channel: cl.channel, marketplace: cl.marketplace, mode: modeOf(r, false), intendedQty: (r as any).quantity ?? null, liveQty: cl.quantity, buffer: cl.stockBuffer ?? 0, routedLocations: (r as any).routedLocations ?? [] })
}
for (const m of mems) {
  const r = resolveMembershipIntended({ marketplace: m.marketplace, followPool: m.followPool ?? true, stockBuffer: m.stockBuffer ?? 0, channelPolicy: policyFor(policies, 'EBAY', m.marketplace), ledger: m.productId ? (ledgers.get(m.productId) ?? []) : [] } as any)
  rows.push({ lane: 'SHARED', sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace, mode: modeOf(r, true), intendedQty: (r as any).quantity ?? null, liveQty: m.lastQtyPushed, buffer: m.stockBuffer ?? 0, routedLocations: (r as any).routedLocations ?? [], itemId: m.itemId })
}
const roll = summarizeProductSync(rows)
console.log('WHOLE PRODUCT: listings=%d channels=%s drift=%d', roll.listings, roll.channels.join('+'), roll.driftCount)
const fams = summarizeFamilies(rows as any, new Map())
for (const f of fams) {
  const scoped = rows.filter((r) => familyKeyOf(r) === f.key)
  const sr = summarizeProductSync(scoped)
  console.log(`  family ${f.key}: rows=${scoped.length} familyDrift=${f.driftCount} | HEADER WOULD SAY: "41 variants · ${scoped.length} listings · ${roll.channels.join(', ')}" and "● ${roll.driftCount} drift"`)
}
await prisma.$disconnect()
