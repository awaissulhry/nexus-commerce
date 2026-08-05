/**
 * P0 TAKEOVER — make the pool drive ALL Amazon FBM listings (owner directive
 * 2026-07-20: listings are uploaded to Amazon at qty 0 via the owner's own
 * Excel; Nexus must take over quantities from the pool, real-time).
 *
 * 1. isPublished=true for Amazon rows whose listingStatus proves they exist
 *    on Amazon (ACTIVE/BUYABLE/DISCOVERABLE) — dispatch was skipping them.
 * 2. Recascade every Amazon-FBM product → pool values push out now.
 * 3. Report uncounted families (listings live, ledger empty) for the owner's
 *    stock import — NO stock is invented here; the pool is the authority.
 * DRY-RUN default; --apply executes.
 */
const apply = process.argv.includes('--apply')
const { default: prisma } = await import('../src/db.js')

const live = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', listingStatus: { in: ['ACTIVE', 'BUYABLE', 'DISCOVERABLE'] } },
  select: {
    id: true, productId: true, isPublished: true, quantity: true, marketplace: true,
    fulfillmentMethod: true, product: { select: { sku: true, fulfillmentMethod: true } },
  },
})
const fbm = live.filter(
  (l) => !((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA')),
)
const toPublish = fbm.filter((l) => !l.isPublished)
console.log(`live-on-Amazon FBM rows: ${fbm.length}; currently isPublished=false: ${toPublish.length}`)

const productIds = [...new Set(fbm.map((l) => l.productId))]
const ledger = await prisma.stockLevel.groupBy({
  by: ['productId'],
  where: { productId: { in: productIds }, location: { type: 'WAREHOUSE' } },
  _sum: { quantity: true, available: true },
})
const ledgerBy = new Map(ledger.map((l) => [l.productId, { qty: l._sum.quantity ?? 0, avail: l._sum.available ?? 0 }]))

const counted = productIds.filter((id) => (ledgerBy.get(id)?.qty ?? 0) > 0)
const uncounted = productIds.filter((id) => (ledgerBy.get(id)?.qty ?? 0) === 0)
console.log(`products: ${productIds.length} (pool counted: ${counted.length}, uncounted/zero: ${uncounted.length})`)

const skusOf = async (ids: string[]) =>
  (await prisma.product.findMany({ where: { id: { in: ids } }, select: { sku: true } })).map((p) => p.sku)
const famCount = (skus: string[]) => {
  const m = new Map<string, number>()
  for (const s of skus) { const f = (s.match(/^([A-Za-z]+)/)?.[1] ?? s).toUpperCase(); m.set(f, (m.get(f) ?? 0) + 1) }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
console.log('\n== UNCOUNTED families (listings live, ledger 0 — load via stock import when ready) ==')
for (const [f, n] of famCount(await skusOf(uncounted))) console.log(`  ${f}: ${n} SKUs`)
console.log('== COUNTED families (pool pushes real quantities on apply) ==')
for (const [f, n] of famCount(await skusOf(counted))) console.log(`  ${f}: ${n} SKUs`)

if (!apply) { console.log('\nDRY-RUN — --apply to execute.'); await prisma.$disconnect(); process.exit(0) }

const pub = await prisma.channelListing.updateMany({
  where: { id: { in: toPublish.map((l) => l.id) } },
  data: { isPublished: true },
})
console.log(`\nisPublished repaired: ${pub.count}`)

const { recascadeProduct } = await import('../src/services/stock-movement.service.js')
let ok = 0, refused = 0, failed = 0
for (const pid of productIds) {
  try {
    const r = await recascadeProduct(pid, { reason: 'SYNC_RECONCILIATION', referenceType: 'P0_TAKEOVER', actor: 'p0-takeover' })
    if (r.ok === false) refused++
    else ok++
  } catch { failed++ }
}
console.log(`recascaded: ok=${ok} refused(NO_LEDGER: totalStock>0 but ledger empty — these need the owner's stock import)=${refused} failed=${failed}`)
await prisma.$disconnect()
process.exit(0)
