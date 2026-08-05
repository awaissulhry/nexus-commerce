/** READ-ONLY: 5-signal FBA diagnosis for the 8 permanently-stuck read-back products. */
const { default: prisma } = await import('../src/db.js')

const SKUS = [
  'YK-29A3-CH9D', 'SQ-75VQ-OZ1Q', 'SQ-0SRL-MWT1', '85-A8DQ-UNYF', 'AE-304M-9LSW',
  'MISANO-JACKET-3XL-BLACK', 'MISANO-JACKET-4XL-BLACK', 'MISANO-JACKET-5XL-BLACK',
]

const products = await prisma.product.findMany({
  where: { sku: { in: SKUS }, deletedAt: null },
  select: { id: true, sku: true, fulfillmentMethod: true, parentId: true, totalStock: true },
})
console.log(`products found: ${products.length} of ${SKUS.length}`)
const missing = SKUS.filter((s) => !products.some((p) => p.sku === s))
if (missing.length) console.log('MISSING:', missing.join(' '))

const ids = products.map((p) => p.id)

const fbaStock = await prisma.stockLevel.findMany({
  where: { productId: { in: ids }, location: { code: 'AMAZON-EU-FBA' } },
  select: { productId: true, quantity: true, available: true },
})
const fbaBy = new Map(fbaStock.map((s) => [s.productId, s.quantity]))

const whStock = await prisma.stockLevel.findMany({
  where: { productId: { in: ids }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true },
})
const whBy = new Map<string, number>()
for (const s of whStock) whBy.set(s.productId, (whBy.get(s.productId) ?? 0) + s.available)

const offers = await prisma.offer.findMany({
  where: { channelListing: { productId: { in: ids } }, fulfillmentMethod: 'FBA', isActive: true },
  select: { channelListing: { select: { productId: true } } },
}).catch(() => [] as Array<{ channelListing: { productId: string } | null }>)
const fbaOfferSet = new Set(offers.map((o) => o.channelListing?.productId))

const cls = await prisma.channelListing.findMany({
  where: { productId: { in: ids }, channel: 'AMAZON' },
  select: {
    id: true, productId: true, marketplace: true, fulfillmentMethod: true, platformAttributes: true,
    followMasterQuantity: true, quantity: true, syncPaused: true, offerClosedAt: true,
    isPublished: true, listingStatus: true, externalListingId: true,
  },
  orderBy: { marketplace: 'asc' },
})

let flippable = 0
const plan: Array<{ id: string; sku: string }> = []
for (const p of products) {
  const rows = cls.filter((c) => c.productId === p.id)
  const fbaQty = fbaBy.get(p.id) ?? 0
  const wh = whBy.get(p.id) ?? 0
  const hasLedger = whStock.some((s) => s.productId === p.id)
  const channelCodes = rows.map((r) =>
    String((r.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase(),
  )
  const signals = {
    productFm: String(p.fulfillmentMethod ?? '').toUpperCase() === 'FBA',
    listingFmAnyFba: rows.some((r) => r.fulfillmentMethod === 'FBA'),
    channelCodeAnyAmazon: channelCodes.some((c) => c.startsWith('AMAZON')),
    fbaStock: fbaQty > 0,
    fbaOffer: fbaOfferSet.has(p.id),
  }
  // Fail-safe predicate: flip ONLY when productFm is the SOLE FBA signal.
  const otherSignals = signals.listingFmAnyFba || signals.channelCodeAnyAmazon || signals.fbaStock || signals.fbaOffer
  const canFlip = signals.productFm && !otherSignals
  if (canFlip) { flippable++; plan.push({ id: p.id, sku: p.sku }) }

  console.log(`\n── ${p.sku}  (product.fm=${p.fulfillmentMethod ?? 'null'}, parent=${p.parentId ? 'child' : 'MASTER'})`)
  console.log(`   pool: warehouse=${wh} ledgerRows=${hasLedger ? 'yes' : 'NONE (uncounted)'} totalStock=${p.totalStock} · fbaStock=${fbaQty} · activeFbaOffer=${fbaOfferSet.has(p.id)}`)
  console.log(`   signals: ${JSON.stringify(signals)}  →  ${canFlip ? '✅ FLIPPABLE (productFm is the only FBA signal)' : '⛔ DO NOT FLIP'}`)
  for (const r of rows) {
    const fa = String((r.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '') || '—'
    console.log(`   ${r.marketplace}  fm=${r.fulfillmentMethod ?? 'null'} chCode=${fa} qty=${r.quantity} follow=${r.followMasterQuantity} pub=${r.isPublished} status=${r.listingStatus} paused=${r.syncPaused} closed=${r.offerClosedAt ? 'YES' : 'no'} asin=${r.externalListingId}`)
  }
}
console.log(`\n=== ${flippable} of ${products.length} pass the fail-safe predicate ===`)
console.log('flip plan:', JSON.stringify(plan))
await prisma.$disconnect()
