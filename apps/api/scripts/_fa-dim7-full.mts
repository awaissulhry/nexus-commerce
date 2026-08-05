const { default: prisma } = await import('../src/db.js')
const { resolveIntendedQuantity } = await import('../src/services/sync-control-core.js')
const { loadChannelPolicies, policyFor } = await import('../src/services/sync-control-policy.service.js')

const MERCHANT = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
function plain(a: { lfm: string | null; channel: string; fbaBucket: number; pfm: string | null }): 'FBA' | 'FBM' {
  if (a.lfm === 'FBA' || a.lfm === 'FBM') return a.lfm
  if (MERCHANT.has(a.channel)) return 'FBM'
  return a.fbaBucket > 0 || a.pfm === 'FBA' ? 'FBA' : 'FBM'
}
function cascadeMethod(a: { lfm: string | null; channel: string; fbaBucket: number; pfm: string | null }): 'FBA' | 'FBM' {
  const r = plain(a)
  if (r === 'FBM' && a.channel === 'AMAZON' && (a.pfm === 'FBA' || a.fbaBucket > 0)) return 'FBA'
  return r
}

const [listings, policies] = await Promise.all([
  prisma.channelListing.findMany({
    where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: {
      id: true, productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
      followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true,
      product: { select: { sku: true, fulfillmentMethod: true } },
    },
  }),
  loadChannelPolicies(),
])
const pids = [...new Set(listings.map((l) => l.productId))]
const levels = await prisma.stockLevel.findMany({
  where: { productId: { in: pids } },
  select: { productId: true, available: true, quantity: true, location: { select: { code: true, type: true, syncRoutes: true } } },
})
const wh = new Map<string, any[]>(); const fbaB = new Map<string, number>()
for (const l of levels) {
  if (l.location?.type === 'WAREHOUSE') {
    const a = wh.get(l.productId) ?? []; a.push({ locationCode: l.location.code, available: l.available, syncRoutes: l.location.syncRoutes ?? [] }); wh.set(l.productId, a)
  }
  if (l.location?.type === 'AMAZON_FBA') fbaB.set(l.productId, (fbaB.get(l.productId) ?? 0) + l.quantity)
}

let uncountedNullQty = 0, uncountedPos = 0, uncountedZero = 0
const exUn: any[] = []
const modeCount: Record<string, number> = {}
for (const cl of listings) {
  const scIsFba = cl.fulfillmentMethod === 'FBA' || cl.product?.fulfillmentMethod === 'FBA'
  const r = resolveIntendedQuantity({
    channel: cl.channel, marketplace: cl.marketplace, isFba: scIsFba,
    followMasterQuantity: cl.followMasterQuantity, syncPaused: cl.syncPaused,
    pinnedQuantity: cl.quantity, stockBuffer: cl.stockBuffer ?? 0,
    sourceLocationCodes: cl.sourceLocationCodes ?? [],
    channelPolicy: policyFor(policies, cl.channel, cl.marketplace),
    ledger: wh.get(cl.productId) ?? [],
  })
  modeCount[r.kind] = (modeCount[r.kind] ?? 0) + 1
  if (r.kind === 'UNCOUNTED') {
    // engine (cascade) view: recompute with cascade isFba
    const engFba = cascadeMethod({ lfm: cl.fulfillmentMethod, channel: cl.channel, fbaBucket: fbaB.get(cl.productId) ?? 0, pfm: cl.product?.fulfillmentMethod ?? null }) === 'FBA'
    if (engFba) continue
    if (cl.quantity == null) { uncountedNullQty++; if (exUn.length < 6) exUn.push({ sku: cl.product?.sku, ch: cl.channel, mk: cl.marketplace, qty: cl.quantity }) }
    else if (cl.quantity > 0) uncountedPos++
    else uncountedZero++
  }
}
console.log('SC mode distribution (listing lane):', modeCount)
console.log('UNCOUNTED rows where cascade WOULD write 0 + enqueue a push (quantity NULL):', uncountedNullQty, JSON.stringify(exUn))
console.log('UNCOUNTED protected (qty>0):', uncountedPos, ' UNCOUNTED already 0 (no-op):', uncountedZero)

// Read-back drift the SC Drift column cannot see
const hl = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED' },
  select: { productId: true, errorMessage: true, createdAt: true, channel: true, localData: true, remoteData: true },
  orderBy: { createdAt: 'desc' }, take: 8,
})
console.log('UNRESOLVED CHANNEL_QTY_READBACK logs:', hl.length)
for (const h of hl) console.log(h.createdAt.toISOString(), h.channel, h.errorMessage?.slice(0, 120))
await prisma.$disconnect()
