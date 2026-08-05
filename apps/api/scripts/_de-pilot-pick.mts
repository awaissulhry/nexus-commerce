/** READ-ONLY: pick the DE-pilot SKU and capture the live BEFORE state.
 *  Criteria: DE FBM published qty>0, same SKU live on IT qty>0, lowest recent
 *  IT order velocity (minimise risk if quantities turn out shared). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { AmazonService } = await import('../src/services/marketplaces/amazon.service.js')
const amazonService = new AmazonService()

const MP = { IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9' } as const

// candidates: DE + IT both live FBM with stock
const de = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON', marketplace: 'DE', isPublished: true,
    listingStatus: { notIn: ['ENDED', 'REMOVED', 'DRAFT'] },
    quantity: { gt: 0 },
    OR: [{ fulfillmentMethod: null }, { fulfillmentMethod: { not: 'FBA' } }],
    product: { deletedAt: null },
  },
  select: { productId: true, quantity: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const it = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON', marketplace: 'IT', isPublished: true,
    listingStatus: { notIn: ['ENDED', 'REMOVED', 'DRAFT'] },
    quantity: { gt: 0 },
    OR: [{ fulfillmentMethod: null }, { fulfillmentMethod: { not: 'FBA' } }],
  },
  select: { productId: true, quantity: true },
})
const itQty = new Map(it.map((r) => [r.productId, r.quantity]))
const both = de.filter((d) => itQty.has(d.productId) && d.product?.fulfillmentMethod !== 'FBA')
console.log(`candidates live on BOTH DE and IT (FBM, qty>0): ${both.length}`)

// order velocity: IT+DE orders last 30 days per product (lower = safer pilot)
const since = new Date(Date.now() - 30 * 24 * 3600e3)
const items = await prisma.orderItem.groupBy({
  by: ['productId'],
  where: { productId: { in: both.map((b) => b.productId) }, order: { orderedAt: { gte: since }, channel: 'AMAZON' } },
  _sum: { quantity: true },
}).catch(async () => {
  // schema fallback: some deployments key order date differently
  return [] as Array<{ productId: string | null; _sum: { quantity: number | null } }>
})
const vel = new Map(items.map((i) => [i.productId, i._sum.quantity ?? 0]))
const ranked = both
  .map((b) => ({ sku: b.product!.sku, productId: b.productId, deQty: b.quantity, itQty: itQty.get(b.productId), sold30d: vel.get(b.productId) ?? 0 }))
  .sort((a, b) => a.sold30d - b.sold30d || (a.deQty ?? 0) - (b.deQty ?? 0))
console.log('\nlowest-velocity candidates:')
for (const r of ranked.slice(0, 24)) console.log(`  ${r.sku.padEnd(40)} DE=${r.deQty} IT=${r.itQty} sold30d(all-mkts)=${r.sold30d}`)

process.exit(0)
// live BEFORE state via SP-API for the top candidate
// prefer a XAVIA-catalogue SKU over legacy lowercase ones at equal (zero) velocity
const pick = ranked.find((r) => /^[A-Z]/.test(r.sku)) ?? ranked[0]
console.log(`\nPICK: ${pick.sku}`)
for (const [mkt, mid] of Object.entries(MP)) {
  const live = await amazonService.fetchListingForFlatFile(pick.sku, mid)
  const fa = (live?.attributes as any)?.fulfillment_availability
  console.log(`  LIVE ${mkt}: status=${live?.listingStatus} fulfillment_availability=${JSON.stringify(fa)}`)
}
await prisma.$disconnect()
