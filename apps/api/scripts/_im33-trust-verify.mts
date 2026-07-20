/**
 * IM.3.3 verify — trust hardening, against prod DB (writes nothing except
 * job audit rows for expected-fail applies).
 *
 * 1. Identity mismatch: tampered resolvedSku and phantom productId rows are
 *    refused with 're-run Preview' errors; nothing written.
 * 2. Quantity range: |q| > 1M refused.
 * 3. FBA exclusion parity: for a product whose Amazon listing resolves FBA,
 *    CHANNEL preview shows zero matching listings (error row) — and apply
 *    refuses the same row (preview = apply).
 * 4. Actor attribution: applyImport with actor lands in createdBy.
 */
const { applyImport, previewImport, ensureDraftImportJob } = await import(
  '/Users/awais/nexus-commerce/apps/api/src/services/stock-import.service.js'
)
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default

let fails = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail)?.slice(0, 200) : ''}`)
  if (!ok) fails++
}
function previewRow(over: Record<string, unknown>) {
  return {
    raw: '', quantity: 0, productId: null, productName: null, resolvedSku: null,
    tier: 'EXACT', candidates: [], currentWarehouseQty: null, wouldBeWarehouseQty: null,
    currentChannelQty: null, wouldBeChannelQty: null, channelListings: [], warnings: [],
    error: null, ...over,
  } as any
}

const loc = await prisma.stockLocation.findUnique({ where: { code: 'IT-MAIN' }, select: { id: true } })
if (!loc) throw new Error('IT-MAIN missing')
const lvl = await prisma.stockLevel.findFirst({
  where: { locationId: loc.id, variationId: null, quantity: { gte: 2 } },
  orderBy: { quantity: 'desc' },
  select: { id: true, productId: true, quantity: true },
})
if (!lvl) throw new Error('no stock at IT-MAIN')
const product = await prisma.product.findUnique({ where: { id: lvl.productId }, select: { id: true, sku: true } })
if (!product) throw new Error('product missing')
const movementsBefore = await prisma.stockMovement.count({ where: { productId: product.id } })

// ── 1+2+4. Tampered rows + range + actor ────────────────────────────────────
{
  const rows = [
    // tampered SKU on a real product
    previewRow({ raw: 'tamper-1', quantity: 1, productId: product.id, productName: 'x', resolvedSku: product.sku + '-TAMPERED' }),
    // phantom productId
    previewRow({ raw: 'tamper-2', quantity: 1, productId: 'cl_does_not_exist_42', productName: 'x', resolvedSku: 'whatever' }),
    // out-of-range quantity
    previewRow({ raw: 'range-1', quantity: 2_000_000, productId: product.id, productName: 'x', resolvedSku: product.sku }),
  ]
  const jobId = await ensureDraftImportJob({ locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', totalRows: 3 })
  const res = await applyImport({ rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', jobId, actor: 'im33-verify@test' })
  check('tampered SKU refused', /re-run Preview/.test(res.results[0]?.error ?? ''), res.results[0]?.error)
  check('phantom productId refused', /re-run Preview/.test(res.results[1]?.error ?? ''), res.results[1]?.error)
  check('out-of-range quantity refused', /out of range/.test(res.results[2]?.error ?? ''), res.results[2]?.error)
  check('all rows failed, none applied', res.failed === 3 && res.succeeded === 0, res)
  const movementsAfter = await prisma.stockMovement.count({ where: { productId: product.id } })
  check('nothing written to the ledger', movementsAfter === movementsBefore)
  const job = await prisma.stockImportJob.findUnique({ where: { id: jobId }, select: { createdBy: true, status: true } })
  check('actor attributed on job', job?.createdBy === 'im33-verify@test', job)
}

// ── 3. FBA exclusion parity (preview + apply agree) ─────────────────────────
{
  // Find a product whose Amazon listing resolves FBA: explicit FBA method,
  // or FBA stock bucket / product-level FBA with no explicit method.
  const fbaCandidates = await prisma.channelListing.findMany({
    where: {
      channel: 'AMAZON',
      listingStatus: { not: 'ENDED' },
      OR: [
        { fulfillmentMethod: 'FBA' },
        { fulfillmentMethod: null, product: { fulfillmentMethod: 'FBA' } },
      ],
    },
    take: 5,
    select: { productId: true, product: { select: { sku: true } } },
  })
  const fbaListing = fbaCandidates.find((c) => c.productId && c.product)
  if (!fbaListing?.productId || !fbaListing.product) {
    console.log('⚠️ no FBA-resolving Amazon listing found — skipping FBA parity check')
  } else {
    const sku = fbaListing.product.sku
    const rows = [{ raw: sku, quantity: 1, channel: 'AMAZON' }]
    const preview = await previewImport({ rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'CHANNEL' })
    const pRow = preview.rows[0]
    const previewExcluded = (pRow?.channelListings?.length ?? 0) === 0
    check(`FBA parity: preview shows no AMAZON listings for FBA product ${sku}`, previewExcluded, pRow?.channelListings)
    const jobId = await ensureDraftImportJob({ locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'CHANNEL', totalRows: 1 })
    const applyRows = [previewRow({ raw: sku, quantity: 1, channel: 'AMAZON', productId: fbaListing.productId, productName: sku, resolvedSku: sku })]
    const res = await applyImport({ rows: applyRows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'CHANNEL', jobId })
    check('FBA parity: apply refuses the same row (no listing matches)', res.failed === 1 && /No active channel listing matches/.test(res.results[0]?.error ?? ''), res.results[0])
  }
}

await new Promise((r) => setTimeout(r, 1000))
await prisma.$disconnect()
console.log(fails === 0 ? '\n🎉 IM.3.3 verify: ALL PASS' : `\n💥 IM.3.3 verify: ${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
