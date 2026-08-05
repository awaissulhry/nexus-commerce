const { default: prisma } = await import('../src/db.js')
const { resolveIntendedQuantity } = await import('../src/services/sync-control-core.js')
const { loadChannelPolicies, policyFor } = await import('../src/services/sync-control-policy.service.js')

const pids = [
  'cmokmy2v90066pm0p7ifrbajf',
  'cmokmy2sn005zpm0pj8hz272g',
  'cmokmy2sa005ypm0pqmy4w542',
  'cmokmy0j10002pm0pnoc35oao',
  'cmokmy10w001cpm0pwcp6d8gv',
  'cmokmy10i001bpm0pdh950vno',
  'cmokmy105001apm0pl1oz4pua',
  'cmokmy2220044pm0pmgrexuct',
]
const policies = await loadChannelPolicies()
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: pids }, channel: 'AMAZON', marketplace: 'ES', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: {
    productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
    followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})
const levels = await prisma.stockLevel.findMany({
  where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
})
const ledgers = new Map<string, any[]>()
for (const l of levels) {
  const a = ledgers.get(l.productId) ?? []
  a.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] })
  ledgers.set(l.productId, a)
}
for (const cl of cls) {
  const isFba = cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') || cl.product?.fulfillmentMethod === 'FBA'
  const r = resolveIntendedQuantity({
    channel: cl.channel, marketplace: cl.marketplace, isFba,
    followMasterQuantity: cl.followMasterQuantity, syncPaused: cl.syncPaused,
    pinnedQuantity: cl.quantity, stockBuffer: cl.stockBuffer ?? 0,
    sourceLocationCodes: cl.sourceLocationCodes ?? [],
    channelPolicy: policyFor(policies, cl.channel, cl.marketplace),
    ledger: ledgers.get(cl.productId) ?? [],
  })
  const intended = r.kind === 'FOLLOW' ? r.quantity : r.kind === 'PINNED' ? r.quantity : null
  const live = cl.quantity
  console.log(
    cl.product?.sku, '| kind=', r.kind, '| intended=', intended, '| SC-live=', live,
    '| DRIFT=', intended != null && live != null && intended !== live ? 'YES' : 'no',
    '| isFba=', isFba, '| follow=', cl.followMasterQuantity,
  )
}
await prisma.$disconnect()
