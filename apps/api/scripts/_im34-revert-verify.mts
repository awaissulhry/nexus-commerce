/**
 * IM.3.4 verify — batch revert against prod DB.
 *
 * Applies ADJUST +2 on one SKU, then reverts the job: stock must return to
 * the starting value via an inverse movement, the revert must appear as its
 * own history job, the original must be marked reverted, and a second
 * revert must be refused. The +2/-2 pair nets to zero and both pushes
 * coalesce inside the 30s hold window.
 */
const { applyImport, revertImport, ensureDraftImportJob, RevertNotAllowedError } = await import(
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
console.log(`subject: ${product.sku} qty=${lvl.quantity}`)

// ── Apply +2 ─────────────────────────────────────────────────────────────────
const rows = [previewRow({ raw: product.sku, quantity: 2, productId: product.id, productName: product.sku, resolvedSku: product.sku })]
const draftId = await ensureDraftImportJob({ locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', totalRows: 1 })
const applyRes = await applyImport({ rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', jobId: draftId, filename: 'im34-verify.csv', actor: 'im34-verify@test' })
check('apply +2 succeeded', applyRes.succeeded === 1, applyRes)
check('apply results carry quantity (retry contract)', applyRes.results[0]?.quantity === 2, applyRes.results[0])
const midLvl = await prisma.stockLevel.findUnique({ where: { id: lvl.id }, select: { quantity: true } })
check('stock is +2 after apply', midLvl?.quantity === lvl.quantity + 2, midLvl)

// ── Revert ───────────────────────────────────────────────────────────────────
const revert = await revertImport(draftId, 'im34-verify@test')
check('revert returned a revert job', typeof revert.revertJobId === 'string' && revert.revertJobId.length > 0, revert)
check('revert inverted 1 product, 0 failed', revert.warehouse.products === 1 && revert.warehouse.succeeded === 1 && revert.warehouse.failed === 0, revert.warehouse)
const endLvl = await prisma.stockLevel.findUnique({ where: { id: lvl.id }, select: { quantity: true } })
check('stock back to starting value', endLvl?.quantity === lvl.quantity, { start: lvl.quantity, end: endLvl?.quantity })

const original = await prisma.stockImportJob.findUnique({ where: { id: draftId }, select: { revertedByJobId: true } })
check('original job marked reverted', original?.revertedByJobId === revert.revertJobId, original)
const revertJob = await prisma.stockImportJob.findUnique({
  where: { id: revert.revertJobId },
  select: { filename: true, status: true, succeeded: true, createdBy: true },
})
check('revert job named + attributed + APPLIED', /revert of im34-verify/.test(revertJob?.filename ?? '') && revertJob?.status === 'APPLIED' && revertJob?.createdBy === 'im34-verify@test', revertJob)

const revMovements = await prisma.stockMovement.findMany({
  where: { referenceType: 'BulkImport', referenceId: revert.revertJobId },
  select: { change: true, notes: true },
})
check('inverse movement -2 with REVERT note', revMovements.length === 1 && revMovements[0]?.change === -2 && /REVERT/.test(revMovements[0]?.notes ?? ''), revMovements)

// ── Second revert refused ────────────────────────────────────────────────────
let refused = false
try {
  await revertImport(draftId)
} catch (err) {
  refused = err instanceof RevertNotAllowedError && /already reverted/i.test(err.message)
}
check('second revert refused', refused)

await new Promise((r) => setTimeout(r, 1500))
await prisma.$disconnect()
console.log(fails === 0 ? '\n🎉 IM.3.4 verify: ALL PASS' : `\n💥 IM.3.4 verify: ${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
