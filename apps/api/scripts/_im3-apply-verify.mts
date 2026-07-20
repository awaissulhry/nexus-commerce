/**
 * IM.3.1 verify — batched apply engine, net-zero against prod DB.
 *
 * 1. ADJUST +1/-1 on one SKU (WAREHOUSE): stock nets unchanged, movement
 *    chain correct, no outbound rows (net-zero → cascade no-op), job APPLIED.
 * 2. Negative guard: huge negative ADJUST fails the row, writes nothing.
 * 3. Integer guard: fractional qty fails the row, writes nothing.
 * 4. Draft idempotency: re-applying the same jobId throws.
 * 5. SQL shape probes: the ChannelListing unnest statements (incl. NULLs in
 *    int[]) execute against zero-matching ids — proves array serialization
 *    without touching a real listing. (CHANNEL/BOTH live test is done in the
 *    UI with the operator.)
 */
const { applyImport, ensureDraftImportJob, ImportAlreadyAppliedError } = await import(
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

// ── Pick a subject SKU with stock at IT-MAIN ─────────────────────────────────
const loc = await prisma.stockLocation.findUnique({ where: { code: 'IT-MAIN' }, select: { id: true } })
if (!loc) throw new Error('IT-MAIN missing')
const lvl = await prisma.stockLevel.findFirst({
  where: { locationId: loc.id, variationId: null, quantity: { gte: 2 } },
  orderBy: { quantity: 'desc' },
  select: { id: true, productId: true, quantity: true, available: true, reserved: true },
})
if (!lvl) throw new Error('no StockLevel with qty>=2 at IT-MAIN')
const product = await prisma.product.findUnique({
  where: { id: lvl.productId },
  select: { id: true, sku: true, totalStock: true },
})
if (!product) throw new Error('product missing')
console.log(`subject: ${product.sku} qty=${lvl.quantity} available=${lvl.available} totalStock=${product.totalStock}`)

const movementCountBefore = await prisma.stockMovement.count({ where: { productId: product.id } })
const pendingQueueBefore = await prisma.outboundSyncQueue.count({
  where: { productId: product.id, syncStatus: 'PENDING' },
})

// ── 1. Net-zero ADJUST +1/-1 ─────────────────────────────────────────────────
{
  const rows = [
    previewRow({ raw: product.sku, quantity: 1, productId: product.id, productName: product.sku, resolvedSku: product.sku }),
    previewRow({ raw: product.sku, quantity: -1, productId: product.id, productName: product.sku, resolvedSku: product.sku }),
  ]
  const jobId = await ensureDraftImportJob({ locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', totalRows: 2 })
  const progress: unknown[] = []
  const t0 = performance.now()
  const res = await applyImport({
    rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', jobId,
    onProgress: (p: unknown) => { progress.push(p) },
  })
  const ms = Math.round(performance.now() - t0)
  console.log(`apply took ${ms}ms; progress snapshots: ${JSON.stringify(progress)}`)

  check('net-zero: succeeded=2 failed=0 skipped=0', res.succeeded === 2 && res.failed === 0 && res.skipped === 0, res)
  const lvlAfter = await prisma.stockLevel.findUnique({ where: { id: lvl.id }, select: { quantity: true, available: true } })
  check('net-zero: StockLevel unchanged', lvlAfter?.quantity === lvl.quantity && lvlAfter?.available === lvl.available, lvlAfter)
  const prodAfter = await prisma.product.findUnique({ where: { id: product.id }, select: { totalStock: true } })
  check('net-zero: totalStock unchanged', prodAfter?.totalStock === product.totalStock, prodAfter)
  const movements = await prisma.stockMovement.findMany({
    where: { productId: product.id, referenceId: jobId },
    orderBy: { createdAt: 'asc' },
    select: { change: true, quantityBefore: true, balanceAfter: true, actor: true, reason: true, notes: true },
  })
  check('net-zero: 2 movement rows', movements.length === 2, movements)
  check(
    'net-zero: chain +1 then -1 with correct before/after',
    movements[0]?.change === 1 && movements[0]?.quantityBefore === lvl.quantity && movements[0]?.balanceAfter === lvl.quantity + 1 &&
    movements[1]?.change === -1 && movements[1]?.quantityBefore === lvl.quantity + 1 && movements[1]?.balanceAfter === lvl.quantity,
    movements,
  )
  check('net-zero: actor/reason parity', movements.every((m) => m.actor === 'bulk-import' && m.reason === 'MANUAL_ADJUSTMENT'), movements[0])
  const movementCountAfter = await prisma.stockMovement.count({ where: { productId: product.id } })
  check('net-zero: exactly 2 new movements total', movementCountAfter === movementCountBefore + 2)
  // Cascade/explicit rows (channelListingId set) must be ZERO for a net-zero
  // import — listing quantities already equal pool−buffer. Shared-fanout rows
  // (channelListingId null) MAY appear when a shared eBay listing's
  // lastQtyPushed had drifted from the pool: that heal is correct behavior
  // (the per-row engine enqueued the same, twice over), but every one must
  // carry exactly the current pool value.
  const newListingRows = await prisma.outboundSyncQueue.count({
    where: { productId: product.id, syncStatus: 'PENDING', channelListingId: { not: null }, createdAt: { gte: new Date(Date.now() - 120_000) } },
  })
  check('net-zero: no cascade/explicit outbound rows', newListingRows === 0, { newListingRows })
  const sharedRows = await prisma.outboundSyncQueue.findMany({
    where: { productId: product.id, syncStatus: 'PENDING', channelListingId: null, createdAt: { gte: new Date(Date.now() - 120_000) } },
    select: { payload: true },
  })
  const pool = lvl.quantity - lvl.reserved
  const sharedOk = sharedRows.every((r) => {
    const updates = (r.payload as { updates?: Array<{ quantity: number }> })?.updates ?? []
    return updates.every((u) => u.quantity === pool)
  })
  check(`net-zero: shared heal rows (${sharedRows.length}) all carry pool value ${pool}`, sharedOk, sharedRows.map((r) => (r.payload as any)?.updates))
  const job = await prisma.stockImportJob.findUnique({ where: { id: jobId }, select: { status: true, succeeded: true, failed: true, results: true } })
  check('net-zero: job APPLIED with per-row results', job?.status === 'APPLIED' && job?.succeeded === 2 && Array.isArray(job?.results) && (job?.results as unknown[]).length === 2, job?.status)
  const last = progress[progress.length - 1] as { processed?: number; total?: number } | undefined
  check('net-zero: progress reached total', last?.processed === 2 && last?.total === 2, last)

  // ── 4. Draft idempotency ──
  let threw = false
  try {
    await applyImport({ rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', jobId })
  } catch (err) {
    threw = err instanceof ImportAlreadyAppliedError
  }
  check('idempotency: same jobId re-apply throws ImportAlreadyAppliedError', threw)
}

// ── 2. Negative guard ────────────────────────────────────────────────────────
{
  const rows = [previewRow({ raw: product.sku, quantity: -1_000_000, productId: product.id, productName: product.sku, resolvedSku: product.sku })]
  const jobId = await ensureDraftImportJob({ locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', totalRows: 1 })
  const res = await applyImport({ rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', jobId })
  check('negative guard: row fails with legacy message', res.failed === 1 && /would drive StockLevel quantity negative/.test(res.results[0]?.error ?? ''), res.results[0])
  const lvlAfter = await prisma.stockLevel.findUnique({ where: { id: lvl.id }, select: { quantity: true } })
  check('negative guard: stock untouched', lvlAfter?.quantity === lvl.quantity)
  const job = await prisma.stockImportJob.findUnique({ where: { id: jobId }, select: { status: true } })
  check('negative guard: job FAILED', job?.status === 'FAILED', job?.status)
}

// ── 3. Integer guard ─────────────────────────────────────────────────────────
{
  const rows = [previewRow({ raw: product.sku, quantity: 1.5, productId: product.id, productName: product.sku, resolvedSku: product.sku })]
  const jobId = await ensureDraftImportJob({ locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', totalRows: 1 })
  const res = await applyImport({ rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', jobId })
  check('integer guard: row fails', res.failed === 1 && /whole number/.test(res.results[0]?.error ?? ''), res.results[0])
  const movementCountAfter = await prisma.stockMovement.count({ where: { productId: product.id } })
  check('integer guard: no movement written', movementCountAfter === movementCountBefore + 2)
}

// ── 5. SQL shape probes (0-row matches; proves array serialization + syntax) ─
{
  const noneIds = ['__im3_none__']
  const oneInt = [0]
  const oneNull: Array<number | null> = [null]
  try {
    await prisma.$executeRaw`
      UPDATE "ChannelListing" AS cl
      SET "masterQuantity" = u.mq, quantity = u.qty,
          "lastSyncStatus" = 'PENDING', "lastSyncedAt" = NULL,
          version = cl.version + 1, "updatedAt" = now()
      FROM (SELECT unnest(${noneIds}::text[]) AS id, unnest(${oneInt}::int[]) AS mq, unnest(${oneInt}::int[]) AS qty) AS u
      WHERE cl.id = u.id`
    check('SQL probe: cascade statement OK', true)
  } catch (err) {
    check('SQL probe: cascade statement OK', false, err instanceof Error ? err.message : err)
  }
  try {
    await prisma.$executeRaw`
      UPDATE "ChannelListing" AS cl
      SET "masterQuantity" = u.mq, "updatedAt" = now()
      FROM (SELECT unnest(${noneIds}::text[]) AS id, unnest(${oneInt}::int[]) AS mq) AS u
      WHERE cl.id = u.id`
    check('SQL probe: snapshot statement OK', true)
  } catch (err) {
    check('SQL probe: snapshot statement OK', false, err instanceof Error ? err.message : err)
  }
  try {
    await prisma.$executeRaw`
      UPDATE "ChannelListing" AS cl
      SET quantity = u.qty,
          "masterQuantity" = COALESCE(u.mq, cl."masterQuantity"),
          "quantityOverride" = u.qty,
          "followMasterQuantity" = false,
          "lastSyncStatus" = 'PENDING', "lastSyncedAt" = NULL,
          version = cl.version + 1, "updatedAt" = now()
      FROM (SELECT unnest(${noneIds}::text[]) AS id, unnest(${oneInt}::int[]) AS qty, unnest(${oneNull}::int[]) AS mq) AS u
      WHERE cl.id = u.id`
    check('SQL probe: explicit+pin statement with NULL int[] OK', true)
  } catch (err) {
    check('SQL probe: explicit+pin statement with NULL int[] OK', false, err instanceof Error ? err.message : err)
  }
}

await new Promise((r) => setTimeout(r, 1500)) // let fire-and-forget read-cache settle
await prisma.$disconnect()
console.log(fails === 0 ? '\n🎉 IM.3.1 verify: ALL PASS' : `\n💥 IM.3.1 verify: ${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
