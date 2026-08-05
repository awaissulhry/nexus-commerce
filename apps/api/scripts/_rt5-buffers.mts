/**
 * RT.5.3 — targeted oversell buffers (owner accepted recommendation D7,
 * 2026-07-20): buffer=1 on AMAZON FBM Following listings whose product has
 * pool ≤ 3 AND ACTIVE listings on ≥ 2 channels (the simultaneous-purchase
 * race is the residual risk real-time can't remove). eBay deliberately
 * EXCLUDED until the owner enables Out-of-Stock control (a 0-qty Trading
 * revise on a live listing errors without it). Dry-run default; --apply.
 */
const apply = process.argv.includes('--apply')
const { default: prisma } = await import('../src/db.js')
const { setStockBuffer } = await import('../src/services/follow-master.service.js')

const pools = await prisma.stockLevel.groupBy({
  by: ['productId'], where: { location: { type: 'WAREHOUSE' } }, _sum: { available: true },
})
const poolBy = new Map(pools.map((p) => [p.productId, p._sum.available ?? 0]))

const active = await prisma.channelListing.findMany({
  where: { listingStatus: 'ACTIVE', channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] } },
  select: { productId: true, channel: true },
})
const channelsByProduct = new Map<string, Set<string>>()
for (const l of active) {
  const s = channelsByProduct.get(l.productId) ?? new Set<string>()
  s.add(l.channel)
  channelsByProduct.set(l.productId, s)
}

const candidates = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON', listingStatus: 'ACTIVE', followMasterQuantity: true, stockBuffer: 0,
    // NB: Prisma `not:'FBA'` would ALSO exclude NULL — most FBM rows are null.
    OR: [{ fulfillmentMethod: null }, { fulfillmentMethod: 'FBM' }],
  },
  select: { productId: true, marketplace: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const targets = candidates.filter((c) => {
  if (c.product?.fulfillmentMethod === 'FBA') return false // canonical guard re-checks anyway
  const pool = poolBy.get(c.productId) ?? 0
  const nCh = channelsByProduct.get(c.productId)?.size ?? 0
  return pool >= 1 && pool <= 3 && nCh >= 2
})
const productIds = [...new Set(targets.map((t) => t.sku ?? t.productId))]
const ids = [...new Set(targets.map((t) => t.productId))]
console.log(`buffer=1 candidates: ${targets.length} AMAZON listings across ${ids.length} products (pool 1-3, ≥2 channels)`)
for (const t of targets.slice(0, 10)) console.log(`  ${t.product?.sku}@${t.marketplace} pool=${poolBy.get(t.productId)}`)

if (!apply) { console.log('\nDRY-RUN — --apply to execute.'); await prisma.$disconnect(); process.exit(0) }

let updated = 0, skippedFba = 0, failed = 0
for (let i = 0; i < ids.length; i += 1) {
  try {
    const res = await setStockBuffer({ productIds: ids.slice(i, i + 1), channel: 'AMAZON', markets: 'ALL', buffer: 1, actor: 'rt5-buffers (D7, 2026-07-20)' })
    updated += res.updated; skippedFba += res.skippedFba
  } catch (err) { failed++; console.log(`  product ${ids[i]} FAILED: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`) }
}
console.log(`applied: updated=${updated} skippedFba=${skippedFba} failedProducts=${failed}`)
await prisma.$disconnect()
process.exit(0)
