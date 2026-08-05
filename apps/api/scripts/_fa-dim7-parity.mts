// DIM7 read-only parity probe: SC computeRows() isFba vs engine resolveCascadePushMethod
const { default: prisma } = await import('../src/db.js')
const { resolveCascadePushMethod } = await import('../src/services/stock-movement.js').catch(() => ({} as any)) as any

// inline copies to avoid import churn
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

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: {
    id: true, productId: true, channel: true, marketplace: true, quantity: true,
    fulfillmentMethod: true, followMasterQuantity: true, syncPaused: true, stockBuffer: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})
const pids = [...new Set(listings.map((l) => l.productId))]
const fbaLevels = await prisma.stockLevel.findMany({
  where: { productId: { in: pids }, location: { type: 'AMAZON_FBA' } },
  select: { productId: true, quantity: true },
})
const fbaBucketOf = new Map<string, number>()
for (const l of fbaLevels) fbaBucketOf.set(l.productId, (fbaBucketOf.get(l.productId) ?? 0) + l.quantity)

let scFbaEngineFbm = 0, scFbmEngineFba = 0
const ex1: any[] = [], ex2: any[] = []
for (const cl of listings) {
  const scIsFba = cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') || cl.product?.fulfillmentMethod === 'FBA'
  const eng = cascadeMethod({ lfm: cl.fulfillmentMethod, channel: cl.channel, fbaBucket: fbaBucketOf.get(cl.productId) ?? 0, pfm: cl.product?.fulfillmentMethod ?? null })
  if (scIsFba && eng === 'FBM') { scFbaEngineFbm++; if (ex1.length < 8) ex1.push({ sku: cl.product?.sku, ch: cl.channel, mk: cl.marketplace, lfm: cl.fulfillmentMethod, pfm: cl.product?.fulfillmentMethod, follow: cl.followMasterQuantity, qty: cl.quantity, paused: cl.syncPaused }) }
  if (!scIsFba && eng === 'FBA') { scFbmEngineFba++; if (ex2.length < 8) ex2.push({ sku: cl.product?.sku, ch: cl.channel, mk: cl.marketplace, lfm: cl.fulfillmentMethod, pfm: cl.product?.fulfillmentMethod, fbaBucket: fbaBucketOf.get(cl.productId), follow: cl.followMasterQuantity, qty: cl.quantity }) }
}
console.log('TOTAL published listings:', listings.length)
console.log('SC=FBA but ENGINE=FBM (UI hides a live push):', scFbaEngineFbm, JSON.stringify(ex1, null, 1))
console.log('SC=not-FBA but ENGINE=FBA (UI shows intended/drift for a never-pushed row):', scFbmEngineFba, JSON.stringify(ex2, null, 1))

// invisible rows: engine cascades ALL listings for a product (no isPublished/status filter)
const hidden = await prisma.channelListing.findMany({
  where: { OR: [{ isPublished: false }, { listingStatus: { in: ['ENDED', 'REMOVED'] } }] },
  select: { channel: true, marketplace: true, isPublished: true, listingStatus: true, followMasterQuantity: true, quantity: true, syncPaused: true, product: { select: { sku: true, fulfillmentMethod: true } }, fulfillmentMethod: true },
})
const hiddenFollow = hidden.filter((h) => h.followMasterQuantity && !(h.fulfillmentMethod === 'FBA' || h.product?.fulfillmentMethod === 'FBA'))
console.log('HIDDEN from SC but cascade-eligible (follow, non-FBA):', hiddenFollow.length, 'of', hidden.length)
console.log(JSON.stringify(hiddenFollow.slice(0, 8), null, 1))

// UNCOUNTED-with-null-quantity: engine writes 0 + enqueues, SC shows no intent
const nullQty = listings.filter((l) => l.quantity == null && l.followMasterQuantity)
console.log('published follow listings with quantity NULL:', nullQty.length)
await prisma.$disconnect()
