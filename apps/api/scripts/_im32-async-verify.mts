/**
 * IM.3.2 verify — async apply + live progress, against prod DB via route
 * injection (same harness style as _im2-smoke.mts).
 *
 * 1. POST /apply with a net-zero +1/-1 → 202 {jobId, async}; poll
 *    /jobs/:id/progress to terminal APPLIED with correct counts; history
 *    detail carries per-row results.
 * 2. Cancel on a finished job → accepted:false with its terminal status.
 * 3. Synthetic stuck APPLYING row (progressAt 10min old) → progress poll
 *    lazily heals it to PARTIAL with the interruption summary (row deleted
 *    after the check).
 */
import Fastify from 'fastify'
import multipartPlugin from '@fastify/multipart'

const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/stock.routes.js')).default
const { ensureDraftImportJob } = await import('/Users/awais/nexus-commerce/apps/api/src/services/stock-import.service.js')
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default

const app = Fastify()
await app.register(multipartPlugin, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } })
await app.register(routes, { prefix: '/api' })

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
  }
}

// ── Subject ──────────────────────────────────────────────────────────────────
const loc = await prisma.stockLocation.findUnique({ where: { code: 'IT-MAIN' }, select: { id: true } })
if (!loc) throw new Error('IT-MAIN missing')
const lvl = await prisma.stockLevel.findFirst({
  where: { locationId: loc.id, variationId: null, quantity: { gte: 2 } },
  orderBy: { quantity: 'desc' },
  select: { id: true, productId: true, quantity: true },
})
if (!lvl) throw new Error('no StockLevel with qty>=2 at IT-MAIN')
const product = await prisma.product.findUnique({ where: { id: lvl.productId }, select: { id: true, sku: true } })
if (!product) throw new Error('product missing')
console.log(`subject: ${product.sku} qty=${lvl.quantity}`)

// ── 1. Async apply via route ─────────────────────────────────────────────────
{
  const rows = [
    previewRow({ raw: product.sku, quantity: 1, productId: product.id, productName: product.sku, resolvedSku: product.sku }),
    previewRow({ raw: product.sku, quantity: -1, productId: product.id, productName: product.sku, resolvedSku: product.sku }),
  ]
  const draftId = await ensureDraftImportJob({ locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', totalRows: 2 })
  const t0 = performance.now()
  const res = await app.inject({
    method: 'POST',
    url: '/api/stock/import/apply',
    payload: { rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE', jobId: draftId },
  })
  const postMs = Math.round(performance.now() - t0)
  const body = res.json()
  check(`async apply: 202 + jobId returned in ${postMs}ms`, res.statusCode === 202 && body.jobId === draftId && body.async === true && body.total === 2, body)
  check('async apply: POST returned fast (<2s — engine detached)', postMs < 2000, postMs)

  let terminal: any = null
  for (let i = 0; i < 30; i++) {
    const pr = await app.inject({ method: 'GET', url: `/api/stock/import/jobs/${draftId}/progress` })
    const pj = pr.json()
    if (pj.job && ['APPLIED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(pj.job.status)) { terminal = pj; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  check('async apply: reached terminal via polling', terminal !== null, terminal?.job?.status)
  check(
    'async apply: APPLIED with processed=2 succeeded=2',
    terminal?.job?.status === 'APPLIED' && terminal?.job?.processed === 2 && terminal?.job?.succeeded === 2 && terminal?.job?.failed === 0,
    terminal?.job,
  )
  const lvlAfter = await prisma.stockLevel.findUnique({ where: { id: lvl.id }, select: { quantity: true } })
  check('async apply: stock netted unchanged', lvlAfter?.quantity === lvl.quantity, lvlAfter)
  const dres = await app.inject({ method: 'GET', url: `/api/stock/import/history/${draftId}` })
  const detail = dres.json()
  check('async apply: history detail has per-row results', Array.isArray(detail.job?.results) && detail.job.results.length === 2, detail.job?.results?.length)
  check('async apply: history has progress columns', detail.job?.startedAt != null && detail.job?.processedRows === 2, { startedAt: detail.job?.startedAt, processedRows: detail.job?.processedRows })

  // ── 2. Cancel on a finished job ──
  const cres = await app.inject({ method: 'POST', url: `/api/stock/import/jobs/${draftId}/cancel` })
  const cbody = cres.json()
  check('cancel on finished job: accepted=false + terminal status', cres.statusCode === 200 && cbody.accepted === false && cbody.status === 'APPLIED', cbody)
}

// ── 3. Stuck APPLYING row heals lazily on poll ───────────────────────────────
{
  const stale = await prisma.stockImportJob.create({
    data: {
      locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE',
      totalRows: 10, processedRows: 4, succeeded: 4,
      status: 'APPLYING',
      startedAt: new Date(Date.now() - 11 * 60_000),
      progressAt: new Date(Date.now() - 10 * 60_000),
      filename: '_im32-synthetic-stuck-test',
    },
    select: { id: true },
  })
  const pr = await app.inject({ method: 'GET', url: `/api/stock/import/jobs/${stale.id}/progress` })
  const pj = pr.json()
  check('stuck heal: stale APPLYING → PARTIAL on poll', pj.job?.status === 'PARTIAL', pj.job?.status)
  check('stuck heal: interruption summary set', /Interrupted/.test(pj.job?.errorSummary ?? ''), pj.job?.errorSummary)
  check('stuck heal: recorded counts preserved', pj.job?.processed === 4 && pj.job?.succeeded === 4, pj.job)
  await prisma.stockImportJob.delete({ where: { id: stale.id } })
  console.log('(synthetic stuck row deleted)')
}

await new Promise((r) => setTimeout(r, 1500))
await prisma.$disconnect()
console.log(fails === 0 ? '\n🎉 IM.3.2 verify: ALL PASS' : `\n💥 IM.3.2 verify: ${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
