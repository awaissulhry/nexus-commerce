/**
 * RT.0.e — materialize quantity for ACTIVE Following FBM listings whose
 * quantity is still null (never cascaded → never pushed; 75 measured).
 * Runs recascadeProduct() per distinct product — the NO_LEDGER guard refuses
 * any product whose totalStock is not ledger-backed (backfill runs first).
 */
const { default: prisma } = await import('../src/db.js')
const { recascadeProduct } = await import('../src/services/stock-movement.service.js')

const nullQty = await prisma.channelListing.findMany({
  where: {
    channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
    listingStatus: 'ACTIVE',
    followMasterQuantity: true,
    quantity: null,
  },
  select: {
    productId: true, channel: true, marketplace: true, fulfillmentMethod: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})
const fbm = nullQty.filter(
  (l) => !(l.channel === 'AMAZON' && ((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA'))),
)
const productIds = [...new Set(fbm.map((l) => l.productId))]
console.log(`null-qty ACTIVE Following FBM listings: ${fbm.length} across ${productIds.length} products`)

let ok = 0, refused = 0, errors = 0
for (const pid of productIds) {
  try {
    const res = await recascadeProduct(pid)
    if (res.ok) {
      ok++
      console.log(`  ✓ ${pid} totalStock=${res.newTotalStock} cascaded=${res.cascade.cascadedListingIds.length} queued=${res.cascade.queuedSyncIds.length}`)
    } else {
      refused++
      console.log(`  ⛔ ${pid} REFUSED ${res.reason} totalStock=${res.totalStock} — run backfill first`)
    }
  } catch (err) {
    errors++
    console.log(`  !! ${pid} ERROR ${err instanceof Error ? err.message : String(err)}`)
  }
}
console.log(`== summary: products=${productIds.length} recascaded=${ok} refused=${refused} errors=${errors} ==`)

const remaining = await prisma.channelListing.count({
  where: {
    channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
    listingStatus: 'ACTIVE',
    followMasterQuantity: true,
    quantity: null,
  },
})
console.log(`ACTIVE Following listings still null-qty (incl. FBA — those stay null by design): ${remaining}`)

await prisma.$disconnect()
process.exit(0)
