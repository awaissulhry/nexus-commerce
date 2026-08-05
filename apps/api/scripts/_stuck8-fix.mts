/** Fix the 8 permanently-stuck read-back products.
 *
 *  Root cause: product.fulfillmentMethod is a stale 'FBA' latch while EVERY
 *  other signal says FBM (listing fm, channel code, FBA stock, FBA offer, and
 *  Amazon's own merchant report which lists them as merchant-fulfilled). The
 *  fail-closed dispatch guard (isFbaListing) vetoes on product.fm alone, so
 *  every read-back heal is guard-skipped — queue row says SUCCESS, nothing
 *  reaches Amazon, drift returns next morning. Forever.
 *
 *  Fix = flip the stale latch, then recascade so pool truth is pushed.
 *  Predicate is fail-safe and RE-CHECKED inside this run: flip ONLY where
 *  product.fm is the SOLE FBA signal. Any real FBA evidence → hold.
 *
 *  Dry-run by default. Pass --apply to write.
 */
const { default: prisma } = await import('../src/db.js')
const APPLY = process.argv.includes('--apply')

const SKUS = [
  'YK-29A3-CH9D', 'SQ-75VQ-OZ1Q', 'SQ-0SRL-MWT1', '85-A8DQ-UNYF', 'AE-304M-9LSW',
  'MISANO-JACKET-3XL-BLACK', 'MISANO-JACKET-4XL-BLACK', 'MISANO-JACKET-5XL-BLACK',
]
console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (pass --apply to write) ===')

const products = await prisma.product.findMany({
  where: { sku: { in: SKUS }, deletedAt: null },
  select: { id: true, sku: true, fulfillmentMethod: true },
})

const safe: Array<{ id: string; sku: string }> = []
for (const p of products) {
  if (String(p.fulfillmentMethod ?? '').toUpperCase() !== 'FBA') {
    console.log(`  SKIP ${p.sku}: product.fm is already ${p.fulfillmentMethod ?? 'null'} (nothing to flip)`)
    continue
  }
  const fba = await prisma.stockLevel.aggregate({
    where: { productId: p.id, location: { code: 'AMAZON-EU-FBA' } }, _sum: { quantity: true },
  })
  const offer = await prisma.offer.findFirst({
    where: { channelListing: { productId: p.id }, fulfillmentMethod: 'FBA', isActive: true }, select: { id: true },
  }).catch(() => null)
  const fbaListing = await prisma.channelListing.findFirst({
    where: { productId: p.id, channel: 'AMAZON', fulfillmentMethod: 'FBA' }, select: { id: true },
  })
  const rows = await prisma.channelListing.findMany({
    where: { productId: p.id, channel: 'AMAZON' }, select: { platformAttributes: true },
  })
  const amazonCode = rows.some((r) =>
    String((r.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '')
      .toUpperCase().startsWith('AMAZON'),
  )
  const evidence = { fbaStock: fba._sum.quantity ?? 0, activeFbaOffer: !!offer, listingFm: !!fbaListing, channelCode: amazonCode }
  const clear = evidence.fbaStock === 0 && !evidence.activeFbaOffer && !evidence.listingFm && !evidence.channelCode
  if (clear) { safe.push({ id: p.id, sku: p.sku }); console.log(`  FLIP  ${p.sku}  (all other signals clear)`) }
  else console.log(`  HOLD  ${p.sku}: real FBA evidence ${JSON.stringify(evidence)}`)
}

console.log(`\nsafe to flip: ${safe.length} of ${products.length}`)
if (!APPLY) { console.log('dry run — no writes'); await prisma.$disconnect(); process.exit(0) }
if (!safe.length) { console.log('nothing to do'); await prisma.$disconnect(); process.exit(0) }

const upd = await prisma.product.updateMany({
  where: { id: { in: safe.map((s) => s.id) }, fulfillmentMethod: 'FBA' },
  data: { fulfillmentMethod: 'FBM' },
})
console.log(`\nproduct.fulfillmentMethod FBA→FBM: ${upd.count} rows`)

// Push pool truth now that the guard no longer vetoes.
const { recascadeProduct } = await import('../src/services/stock-movement.service.js')
let ok = 0, noLedger = 0, failed = 0, queued = 0
for (const s of safe) {
  try {
    const r = await recascadeProduct(s.id, { reason: 'SYNC_RECONCILIATION', actor: 'script:stuck8-fix' })
    if (r.ok) {
      ok++
      const n = (r.cascade as any)?.queuedSyncIds?.length ?? 0
      queued += n
      console.log(`  recascade ${s.sku}: ok, pool=${r.newTotalStock}, pushes queued=${n}`)
    } else {
      noLedger++
      console.log(`  recascade ${s.sku}: REFUSED ${r.reason} totalStock=${r.totalStock}`)
    }
  } catch (e) {
    failed++
    console.log(`  recascade ${s.sku}: FAILED ${e instanceof Error ? e.message : String(e)}`)
  }
}
console.log(`\nrecascade: ok=${ok} noLedger=${noLedger} failed=${failed} pushesQueued=${queued}`)
await prisma.$disconnect()
