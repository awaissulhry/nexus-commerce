/**
 * RT.0.d — seed the WAREHOUSE StockLevel ledger from Product.totalStock for
 * every product whose totalStock is not ledger-backed (owner-approved
 * 2026-07-19: totalStock treated as truth; never auto-zero).
 *
 * DRY-RUN by default — prints the full plan. Pass --apply to execute.
 * Movements: reason STOCKLEVEL_BACKFILL, referenceType RT0_BACKFILL.
 * The cascade runs per product (heals drifted Following listings + enqueues
 * corrective pushes drained by the prod cron).
 */
const apply = process.argv.includes('--apply')
const { default: prisma } = await import('../src/db.js')
const { applyStockMovement } = await import('../src/services/stock-movement.service.js')

const pools = await prisma.stockLevel.groupBy({
  by: ['productId'],
  where: { location: { type: 'WAREHOUSE' } },
  _sum: { available: true },
})
const pooled = new Set(pools.map((p) => p.productId))
const prods = await prisma.product.findMany({
  where: { totalStock: { gt: 0 } },
  select: { id: true, sku: true, totalStock: true, fulfillmentMethod: true },
})
const targets = prods.filter((p) => !pooled.has(p.id))

console.log(`== RT.0.d ledger backfill — ${apply ? 'APPLY' : 'DRY-RUN'} ==`)
console.log(`no-ledger products: ${targets.length}`)

let applied = 0, skippedFba = 0, failed = 0
const results: Array<{ sku: string; totalStock: number; after?: number; status: string }> = []

for (const p of targets) {
  if (String(p.fulfillmentMethod ?? '').toUpperCase() === 'FBA') {
    skippedFba++
    results.push({ sku: p.sku, totalStock: p.totalStock, status: 'SKIPPED_FBA (stock is Amazon-side)' })
    continue
  }
  const listings = await prisma.channelListing.count({
    where: { productId: p.id, listingStatus: 'ACTIVE' },
  })
  if (!apply) {
    results.push({ sku: p.sku, totalStock: p.totalStock, status: `PLAN +${p.totalStock} → IT-MAIN (${listings} active listings will recascade)` })
    continue
  }
  try {
    await applyStockMovement({
      productId: p.id,
      change: p.totalStock,
      reason: 'STOCKLEVEL_BACKFILL',
      referenceType: 'RT0_BACKFILL',
      referenceId: p.sku,
      actor: 'rt0-backfill',
      notes: 'RT.0.d ledger backfill — totalStock treated as truth (owner-approved 2026-07-19)',
    })
    const after = await prisma.product.findUnique({ where: { id: p.id }, select: { totalStock: true } })
    const ok = after?.totalStock === p.totalStock
    if (!ok) failed++
    else applied++
    results.push({
      sku: p.sku, totalStock: p.totalStock, after: after?.totalStock ?? -1,
      status: ok ? 'APPLIED (totalStock unchanged ✓)' : `!! MISMATCH after=${after?.totalStock}`,
    })
  } catch (err) {
    failed++
    results.push({ sku: p.sku, totalStock: p.totalStock, status: `ERROR ${err instanceof Error ? err.message : String(err)}` })
  }
}

for (const r of results) console.log(`  ${r.sku}  stock=${r.totalStock}  ${r.status}`)
console.log(`== summary: targets=${targets.length} applied=${applied} skippedFba=${skippedFba} failed=${failed} ==`)

if (apply) {
  const residual = await prisma.product.findMany({
    where: { totalStock: { gt: 0 } },
    select: { id: true },
  })
  const pools2 = await prisma.stockLevel.groupBy({
    by: ['productId'],
    where: { location: { type: 'WAREHOUSE' } },
    _sum: { available: true },
  })
  const pooled2 = new Set(pools2.map((p) => p.productId))
  const still = residual.filter((p) => !pooled2.has(p.id)).length
  console.log(`== verify: no-ledger products remaining = ${still} (FBA-skipped expected) ==`)
}

await prisma.$disconnect()
process.exit(0)
