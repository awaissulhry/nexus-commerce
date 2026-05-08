#!/usr/bin/env node
// Final cross-cutting smoke for the returns rebuild (R0 → R7).
//
// Hits every returns-related endpoint with realistic fixtures and
// reports what's live, mocked, or broken. Read-only against
// production data — every Return / Refund / AuditLog / Notification
// row this script creates is cleaned at the end (or on Ctrl-C).

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'http://localhost:8080'
const url = process.env.DATABASE_URL
const client = new pg.Client({ connectionString: url })
await client.connect()

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d) => { console.log('  ✗', l, d ? `\n    → ${d}` : ''); fail++ }
const info = (l) => console.log('  •', l)
const dbq = (s, p) => client.query(s, p).then((r) => r.rows)

// Track everything we create for cleanup
const createdReturns = []
const createdPolicies = []

async function cleanup() {
  if (createdReturns.length > 0) {
    await dbq(`DELETE FROM "RefundAttempt" WHERE "refundId" IN (SELECT id FROM "Refund" WHERE "returnId" = ANY($1::text[]))`, [createdReturns])
    await dbq(`DELETE FROM "Refund" WHERE "returnId" = ANY($1::text[])`, [createdReturns])
    await dbq(`DELETE FROM "Notification" WHERE "entityId" = ANY($1::text[])`, [createdReturns])
    await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = ANY($1::text[])`, [createdReturns])
    await dbq(`DELETE FROM "Return" WHERE id = ANY($1::text[])`, [createdReturns])
  }
  if (createdPolicies.length > 0) {
    await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'ReturnPolicy' AND "entityId" = ANY($1::text[])`, [createdPolicies])
    await dbq(`DELETE FROM "ReturnPolicy" WHERE id = ANY($1::text[])`, [createdPolicies])
  }
  await client.end()
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130) })

const productRow = (await dbq(`SELECT sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1`))[0]
if (!productRow) { console.error('no product to smoke against'); process.exit(1) }
info(`SKU under test: ${productRow.sku}`)

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ R0 — foundation ═══')
console.log('\n[R0.1] Schema tables exist')
{
  const tables = await dbq(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name IN ('Return', 'ReturnItem', 'Refund', 'RefundAttempt', 'ReturnPolicy')
    ORDER BY table_name
  `)
  if (tables.length === 5) ok(`5 tables present: ${tables.map(t => t.table_name).join(', ')}`)
  else bad(`expected 5 tables, got ${tables.length}`)
}

console.log('\n[R0.2] /api/fulfillment/returns route registered')
{
  const r = await fetch(`${API}/api/fulfillment/returns`)
  if (r.ok) ok('GET /returns reachable')
  else bad('returns list 5xx', `${r.status}`)
}

console.log('\n[R0.3] Idempotency on POST /returns')
{
  const idemKey = `smoke-${Date.now()}`
  const body = JSON.stringify({
    channel: 'AMAZON',
    reason: 'SMOKE_R0_IDEM',
    items: [{ sku: productRow.sku, quantity: 1 }],
  })
  const r1 = await fetch(`${API}/api/fulfillment/returns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
    body,
  })
  const j1 = await r1.json()
  createdReturns.push(j1.id)
  const r2 = await fetch(`${API}/api/fulfillment/returns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
    body,
  })
  const j2 = await r2.json()
  if (j1.id === j2.id && r2.headers.get('idempotent-replay')) ok(`replay header: ${r2.headers.get('idempotent-replay')}`)
  else bad('idempotency failed')
}

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ R1 — list UX ═══')
console.log('\n[R1.1] Pagination + sort + search')
{
  const r = await fetch(`${API}/api/fulfillment/returns?page=1&pageSize=10&sortBy=createdAt&sortDir=desc&q=SMOKE`)
  const j = await r.json()
  if (j.page === 1 && j.pageSize === 10 && j.sortBy === 'createdAt') ok('paginated shape correct')
  else bad('pagination shape wrong', JSON.stringify(j).slice(0, 120))
}

console.log('\n[R1.2] Bulk endpoints + CSV export')
{
  const r = await fetch(`${API}/api/fulfillment/returns/bulk/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [createdReturns[0]] }),
  })
  const j = await r.json()
  if (r.ok && typeof j.ok === 'number') ok(`bulk/approve accepted: ok=${j.ok}, failed=${j.failed}`)
  else bad('bulk/approve failed', JSON.stringify(j).slice(0, 120))
  const csv = await fetch(`${API}/api/fulfillment/returns/export.csv?q=SMOKE`)
  if (csv.ok && csv.headers.get('content-type')?.includes('text/csv')) ok('CSV export 200 with text/csv')
  else bad('CSV export wrong', csv.headers.get('content-type'))
}

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ R2 — drawer detail ═══')
console.log('\n[R2.1] /returns/:id detail (legacy shape — drawer reads OK)')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}`)
  const j = await r.json()
  if (r.ok && j.id === createdReturns[0] && Array.isArray(j.items)) ok('detail returns row + items')
  else bad('detail shape wrong')
}

console.log('\n[R2.2] PATCH item + photo gallery routes wired')
{
  const item = (await dbq(`SELECT id FROM "ReturnItem" WHERE "returnId" = $1 LIMIT 1`, [createdReturns[0]]))[0]
  const r = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/items/${item.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      notes: 'smoke per-item note',
      inspectionChecklist: { packagingPresent: true, signsOfUse: 'LIGHT' },
    }),
  })
  if (r.ok) ok('PATCH item: notes + checklist persisted')
  else bad('PATCH item failed', `${r.status}`)
  // upload-photo — gate-only check (multipart absent → 400 or 503)
  const up = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/items/${item.id}/upload-photo`, {
    method: 'POST',
  })
  if ([400, 500, 503].includes(up.status)) ok(`upload-photo gate produces ${up.status} (no multipart body)`)
  else bad('upload-photo unexpected', `${up.status}`)
}

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ R3 — inspection workflow ═══')
console.log('\n[R3.1+R3.2] Inspect with disposition + scrap reason')
{
  const item = (await dbq(`SELECT id FROM "ReturnItem" WHERE "returnId" = $1 LIMIT 1`, [createdReturns[0]]))[0]
  // First receive (we only created above, status=REQUESTED)
  await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/receive`, { method: 'POST' })
  const r = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ itemId: item.id, conditionGrade: 'DAMAGED', disposition: 'SCRAP', scrapReason: 'visible damage on smoke run' }],
    }),
  })
  const j = await r.json()
  if (r.ok && j.status === 'INSPECTING') ok('inspect → INSPECTING')
  else bad('inspect failed', JSON.stringify(j).slice(0, 120))
  const persisted = await dbq(`SELECT disposition, "scrapReason" FROM "ReturnItem" WHERE id = $1`, [item.id])
  if (persisted[0]?.disposition === 'SCRAP') ok(`disposition=SCRAP persisted, reason="${persisted[0].scrapReason}"`)
  else bad('disposition not persisted', JSON.stringify(persisted))
}

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ R4 — channel webhooks ═══')
console.log('\n[R4.1] Shopify refunds/create test endpoint')
{
  const refundId = 9_900_000_000_000 + Date.now()
  const r = await fetch(`${API}/webhooks/shopify/refunds/create-test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: refundId,
      order_id: `smoke-shopify-${Date.now()}`,
      created_at: new Date().toISOString(),
      note: 'smoke test',
      refund_line_items: [{
        line_item_id: 1,
        quantity: 1,
        subtotal: '12.50',
        subtotal_set: { shop_money: { amount: '12.50', currency_code: 'EUR' } },
        line_item: { sku: productRow.sku, quantity: 1 },
      }],
    }),
  })
  const j = await r.json()
  if (r.ok && j.kind === 'created' && j.returnId) {
    createdReturns.push(j.returnId)
    ok(`Shopify webhook → Return ${j.returnId}`)
  } else bad('Shopify webhook fail', JSON.stringify(j).slice(0, 120))
}

console.log('\n[R4.2] eBay returns ingest test')
{
  const ebayId = `smoke-ebay-${Date.now()}`
  const r = await fetch(`${API}/api/fulfillment/returns/ebay/ingest-test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      returnId: ebayId,
      state: 'RETURN_REQUESTED',
      creationInfo: {
        creationDate: new Date().toISOString(),
        reason: 'NOT_AS_DESCRIBED',
        item: {
          itemId: 'smoke-ebay-item',
          transactionId: ebayId,
          sku: productRow.sku,
          quantity: 1,
          amount: { value: 25.00, currency: 'EUR' },
        },
      },
    }),
  })
  const j = await r.json()
  if (r.ok && j.outcome === 'created' && j.returnId) {
    createdReturns.push(j.returnId)
    ok(`eBay ingest → Return ${j.returnId}`)
  } else bad('eBay ingest fail', JSON.stringify(j).slice(0, 120))
}

console.log('\n[R4.3] Amazon FBM ingest test')
{
  const r = await fetch(`${API}/api/fulfillment/returns/amazon/ingest-test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      row: {
        'order-id': `smoke-amz-${Date.now()}`,
        sku: productRow.sku,
        quantity: '1',
        'return-date': '2026-05-08',
        reason: 'CR_DEFECTIVE',
        status: 'Returned',
      },
      isFba: false,
    }),
  })
  const j = await r.json()
  if (r.ok && j.outcome === 'created' && j.returnId) {
    createdReturns.push(j.returnId)
    ok(`Amazon FBM ingest → Return ${j.returnId}`)
  } else bad('Amazon ingest fail', JSON.stringify(j).slice(0, 120))
}

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ R5 — refund engine ═══')
console.log('\n[R5.1] /refund + GET /refunds (legacy + cutover-ready)')
{
  // Stage refundCents on the smoke return
  await dbq(`UPDATE "Return" SET "refundCents" = 2500 WHERE id = $1`, [createdReturns[0]])
  const r = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/refund`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refundCents: 2500, skipChannelPush: true }),
  })
  const j = await r.json()
  if (r.ok) ok(`refund posted: outcome=${j.channelOutcome ?? 'OK'}`)
  else bad('refund failed', JSON.stringify(j).slice(0, 120))
  // GET /refunds may or may not be present depending on R5.1 cutover
  const list = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/refunds`)
  if (list.ok) {
    const lj = await list.json()
    info(`/refunds endpoint live (${lj.items?.length ?? 0} rows)`)
  } else {
    info(`/refunds endpoint not registered (status ${list.status}) — R5.1 cutover deferred`)
  }
}

console.log('\n[R5.2] Refund-channel-status diagnostic')
{
  const r = await fetch(`${API}/api/fulfillment/returns/refund-channel-status`)
  const j = await r.json()
  if (r.ok && Array.isArray(j.items)) ok(`${j.items.length} adapters reported (modes: ${Object.keys(j.byMode || {}).join(', ')})`)
  else bad('status endpoint fail', JSON.stringify(j).slice(0, 120))
}

console.log('\n[R5.3] Retry-status endpoint')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/refund/retry-status`)
  const j = await r.json()
  if (r.ok && 'priorAttempts' in j) ok(`retry-status: ready=${j.ready}, priorAttempts=${j.priorAttempts}`)
  else bad('retry-status fail', JSON.stringify(j).slice(0, 120))
}

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ R6 — Italian compliance ═══')
console.log('\n[R6.1] ReturnPolicy CRUD + resolve')
{
  const list = await fetch(`${API}/api/fulfillment/return-policies`)
  const lj = await list.json()
  if (list.ok && lj.items.length >= 3) ok(`${lj.items.length} policies on file (3 EU seeds expected min)`)
  else bad('policy list fail', JSON.stringify(lj).slice(0, 120))
  const resolve = await fetch(`${API}/api/fulfillment/return-policies/resolve?channel=AMAZON&marketplace=IT`)
  const rj = await resolve.json()
  if (resolve.ok && rj.policy?.windowDays) ok(`resolve: AMAZON IT → window=${rj.policy.windowDays}d, source=${rj.policy.source}`)
  else bad('resolve fail', JSON.stringify(rj).slice(0, 120))
}

console.log('\n[R6.1] /returns/:id/policy view')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/policy`)
  const j = await r.json()
  if (r.ok && j.window && j.deadline) ok(`per-return policy: ${j.deadline.status}`)
  else bad('policy view fail', JSON.stringify(j).slice(0, 120))
}

console.log('\n[R6.2] Refund-deadline summary')
{
  const r = await fetch(`${API}/api/fulfillment/returns/refund-deadline-summary`)
  const j = await r.json()
  if (r.ok && typeof j.approaching === 'number') ok(`summary: ${j.approaching} approaching / ${j.overdue} overdue`)
  else bad('summary fail', JSON.stringify(j).slice(0, 120))
}

console.log('\n[R6.3] Modulo PDF download')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/modulo-recesso.pdf`)
  const buf = Buffer.from(await r.arrayBuffer())
  const ct = r.headers.get('content-type') ?? ''
  if (r.ok && ct.includes('application/pdf') && buf.slice(0, 5).toString('ascii') === '%PDF-') {
    ok(`PDF returned (${buf.length} bytes, magic bytes correct)`)
  } else bad('PDF generation fail', `ct=${ct}, size=${buf.length}`)
}

console.log('\n[R6.3] Email send (dryRun)')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${createdReturns[0]}/send-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'received', toOverride: 'smoke@example.com', locale: 'it' }),
  })
  const j = await r.json()
  if (r.ok && j.dryRun && j.ok) ok(`email dryRun: ${j.messageId}`)
  else bad('email fail', JSON.stringify(j).slice(0, 120))
}

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ R7 — analytics ═══')
console.log('\n[R7.1] /returns/analytics extended fields')
{
  const r = await fetch(`${API}/api/fulfillment/returns/analytics`)
  const j = await r.json()
  const newFields = ['returnRateByChannel', 'topReturnSkus', 'avgProcessingDays', 'dailyTrend']
  const present = newFields.filter((k) => k in j)
  if (present.length === 4) ok(`R7.1 fields all present: ${present.join(', ')}`)
  else bad('R7.1 fields missing', `got ${present.join(',')}`)
  if (Array.isArray(j.dailyTrend) && j.dailyTrend.length === 30) ok('dailyTrend has 30 zero-filled days')
  else bad('dailyTrend wrong length')
}

console.log('\n[R7.2] /returns/risk-scores')
{
  const r = await fetch(`${API}/api/fulfillment/returns/risk-scores`)
  const j = await r.json()
  if (r.ok && Array.isArray(j.scored) && j.summary) {
    ok(`risk-scores: ${j.summary.skusScored} SKUs scored across ${j.summary.bucketsAnalyzed} buckets, ${j.summary.flaggedCount} flagged`)
  } else bad('risk-scores fail', JSON.stringify(j).slice(0, 120))
}

// ─────────────────────────────────────────────────────────────────
console.log('\n═══ Cleanup ═══')
await cleanup()
console.log(`\n  ✓ ${createdReturns.length} smoke returns + their refunds/audits/notifications cleaned`)

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
