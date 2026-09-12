// PES.8 verification — the whole draft -> review -> apply spine, end to end,
// with ZERO AI calls (hub ruling #13: no live generation).
//
// The drafts here are hand-written, which is the point: 8.1 was designed so the
// review and apply path could be proven before generation existed. Nothing in
// approveDrafts knows or cares whether a draft came from a model.
//
// Writes go to the XAVIA test family only, and the script restores the cell it
// touched before it exits.
import '../src/env.js'
import Fastify from 'fastify'

const { default: prisma } = await import('../src/db.js')
const { default: productsRoutes } = await import('../src/routes/products.routes.js')
const { approveDrafts, listDrafts, rejectDrafts, recordDrafts } = await import(
  '../src/services/ai/enrichment/draft.service.js'
)
const { encodeCellKey } = await import('../src/services/ai/enrichment/cell-key.js')

const SKU = 'AIREON'
const ok = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) process.exitCode = 1
}

const product = await prisma.product.findFirst({
  where: { sku: SKU },
  select: { id: true, sku: true, name: true, description: true },
})
if (!product) throw new Error(`XAVIA fixture ${SKU} not found`)
console.log(`fixture: ${product.sku} (${product.id})`)
const ORIGINAL_DESCRIPTION = product.description
// Render null and '' distinguishably — the restore assertion compares them
// strictly, so a log that collapses the two hides a real difference.
console.log(
  'original description:',
  ORIGINAL_DESCRIPTION === null ? 'null' : `${JSON.stringify(ORIGINAL_DESCRIPTION.slice(0, 60))}...`,
)

// A minimal app carrying the REAL bulk-PATCH handler. Deliberately not the
// full index.ts boot: that starts queue workers and crons against production
// (reference_local_api_duplicates_prod_crons). approveDrafts only needs an
// instance it can inject `/api/products/bulk` into, and this is that route,
// unmodified.
const app = Fastify({ logger: false })
await app.register(productsRoutes, { prefix: '/api' })
await app.ready()

// RBAC runs as a global preHandler in index.ts, which this instance does not
// register — the permission mapping for these routes is proven separately by
// _pes8-rbac-check.mts. What this script proves is the WRITE path.
const request = { headers: {}, ip: '127.0.0.1', authUser: { id: 'pes8-verification' } } as never

const address = {
  channel: null,
  marketplace: null,
  aliasId: null,
  locale: null,
  writeField: 'description',
}
const cellKey = encodeCellKey(address)
const DRAFT_TEXT = `PES.8 verification draft ${new Date().toISOString()} — synthetic, not model-written.`

const cleanup = async () => {
  await prisma.productAiDraft.deleteMany({ where: { productId: product.id, runId: { startsWith: 'pes8-verify-' } } })
  await prisma.product.update({ where: { id: product.id }, data: { description: ORIGINAL_DESCRIPTION } })
}

try {
  await cleanup()
  const runId = `pes8-verify-${Date.now()}`

  // ── 1. Record a draft ──────────────────────────────────────────────
  const rec = await recordDrafts(runId, 'synthetic', 'none', [
    {
      productId: product.id,
      market: 'IT',
      cellKey,
      address,
      columnKey: 'description',
      draftValue: DRAFT_TEXT,
      baseValue: ORIGINAL_DESCRIPTION,
      baseSource: 'stored',
      status: 'pending',
      confidence: 'high',
      rationale: 'verification fixture',
      promptHash: 'verify',
      capsUsed: { maxLength: null },
      violations: null,
    },
  ])
  ok('1. draft recorded', rec.created === 1, `created=${rec.created}`)

  // ── 2. Overlay reads it back with the diff ─────────────────────────
  let drafts = await listDrafts({ productIds: [product.id], status: ['pending'] })
  const d = drafts.find((x) => x.cellKey === cellKey)
  ok('2. overlay returns the draft', !!d)
  ok('2a. diff carries base + draft', d?.baseValue === ORIGINAL_DESCRIPTION && d?.draftValue === DRAFT_TEXT)
  ok('2b. not stale (cell untouched)', d?.stale === false, `stale=${d?.stale}`)
  ok('2c. not unverified (address resolved)', d?.unverified === false, `unverified=${d?.unverified}`)

  // ── 3. The staleness gate ──────────────────────────────────────────
  // Move the cell under the draft, exactly as another operator or a sync would.
  await prisma.product.update({
    where: { id: product.id },
    data: { description: 'SOMEONE ELSE EDITED THIS' },
  })
  drafts = await listDrafts({ productIds: [product.id], status: ['pending'] })
  const stale = drafts.find((x) => x.cellKey === cellKey)
  ok('3. overlay now reports stale', stale?.stale === true, `stale=${stale?.stale}`)
  ok('3a. and surfaces the current value', stale?.currentValue === 'SOMEONE ELSE EDITED THIS')

  const refusedRes = await approveDrafts(app, request, [d!.id])
  ok(
    '3b. approve REFUSES a stale draft by default',
    refusedRes.approved.length === 0 && refusedRes.refused.length === 1,
    refusedRes.refused[0]?.reason ?? '',
  )

  // Put it back so the rest of the run tests the clean path.
  await prisma.product.update({ where: { id: product.id }, data: { description: ORIGINAL_DESCRIPTION } })

  // ── 4. Approve replays through PATCH /api/products/bulk ────────────
  const res = await approveDrafts(app, request, [d!.id])
  ok('4. approve applied', res.approved.length === 1 && res.refused.length === 0, JSON.stringify(res.refused))

  // ── 5. The value actually round-trips (read it fresh from the DB) ──
  const after = await prisma.product.findUnique({
    where: { id: product.id },
    select: { description: true },
  })
  ok('5. value round-trips to the catalogue', after?.description === DRAFT_TEXT)

  const row = await prisma.productAiDraft.findUnique({ where: { id: d!.id } })
  ok('5a. draft stamped approved', row?.status === 'approved', `status=${row?.status}`)
  ok('5b. decision attributed', row?.decidedBy === 'pes8-verification' && !!row?.decidedAt)

  // ── 6. The audit trail names the AI provenance ─────────────────────
  const audits = await prisma.auditLog.findMany({
    where: { entityType: 'Product', entityId: product.id, action: 'ai-draft.approve' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })
  const meta = (audits[0]?.metadata ?? {}) as Record<string, unknown>
  ok('6. ai-draft.approve audit row written', audits.length === 1)
  ok('6a. audit carries draft + run provenance', meta.draftId === d!.id && meta.runId === runId)
  const bulkAudits = await prisma.auditLog.findMany({
    where: { entityType: 'Product', entityId: product.id, action: 'update' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })
  ok("6b. bulk PATCH's own audit row also written", bulkAudits.length === 1)

  // ── 7. Supersession: a second run retires the first pending draft ──
  const runId2 = `pes8-verify-${Date.now()}-b`
  await recordDrafts(runId2, 'synthetic', 'none', [
    {
      productId: product.id,
      market: 'IT',
      cellKey,
      address,
      columnKey: 'description',
      draftValue: 'second draft',
      baseValue: DRAFT_TEXT,
      baseSource: 'stored',
      status: 'pending',
      confidence: 'medium',
      rationale: 'second run',
      promptHash: 'verify2',
      capsUsed: null,
      violations: null,
    },
  ])
  const runId3 = `pes8-verify-${Date.now()}-c`
  const rec3 = await recordDrafts(runId3, 'synthetic', 'none', [
    {
      productId: product.id,
      market: 'IT',
      cellKey,
      address,
      columnKey: 'description',
      draftValue: 'third draft',
      baseValue: DRAFT_TEXT,
      baseSource: 'stored',
      status: 'pending',
      confidence: 'medium',
      rationale: 'third run',
      promptHash: 'verify3',
      capsUsed: null,
      violations: null,
    },
  ])
  ok('7. third run superseded the second', rec3.superseded === 1, `superseded=${rec3.superseded}`)
  const pendingNow = await prisma.productAiDraft.count({
    where: { productId: product.id, cellKey, status: 'pending' },
  })
  ok('7a. exactly ONE pending draft per cell', pendingNow === 1, `pending=${pendingNow}`)

  // ── 8. Reject ──────────────────────────────────────────────────────
  const pending = await prisma.productAiDraft.findFirst({
    where: { productId: product.id, cellKey, status: 'pending' },
  })
  const rej = await rejectDrafts(request, [pending!.id])
  ok('8. reject decided the draft', rej.rejected === 1)
  const beforeReject = await prisma.product.findUnique({
    where: { id: product.id },
    select: { description: true },
  })
  ok('8a. reject wrote NOTHING to the catalogue', beforeReject?.description === DRAFT_TEXT)
} finally {
  await cleanup()
  const restored = await prisma.product.findUnique({
    where: { id: product.id },
    select: { description: true },
  })
  ok('9. fixture restored', restored?.description === ORIGINAL_DESCRIPTION)
  await app.close()
  await prisma.$disconnect()
}
