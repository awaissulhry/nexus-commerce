#!/usr/bin/env node
// H.0a end-to-end verification. Creates a throwaway supplier + PO,
// runs the receive flow at three checkpoints, asserts PO state at
// each, and cleans up everything on exit (success or fail).
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-h0a.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const TEST_TAG = `H0A_VERIFY_${Date.now()}`
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}
async function api(method, path, body) {
  const opts = { method }
  if (body != null) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API_BASE}${path}`, opts)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

let supplierId, poId, inboundId, inboundItemId

async function findRealTestProduct() {
  const r = await client.query(`
    SELECT id, sku FROM "Product"
    WHERE "isParent" = false
    ORDER BY "createdAt" DESC LIMIT 1
  `)
  return r.rows[0]
}

async function cleanup() {
  console.log('[verify-h0a] cleanup')
  // Cascade does most of the work — Inbound→Items, PO→Items.
  // Supplier deletion is restricted by FK; cascade-set on PO supplier
  // means we must drop the PO first (which we already do).
  if (inboundId) {
    try { await client.query(`DELETE FROM "InboundShipment" WHERE id = $1`, [inboundId]) } catch (e) { console.log('inbound cleanup error:', e.message) }
  }
  if (poId) {
    try { await client.query(`DELETE FROM "PurchaseOrder" WHERE id = $1`, [poId]) } catch (e) { console.log('PO cleanup error:', e.message) }
  }
  if (supplierId) {
    try { await client.query(`DELETE FROM "Supplier" WHERE id = $1`, [supplierId]) } catch (e) { console.log('supplier cleanup error:', e.message) }
  }
}

try {
  const product = await findRealTestProduct()
  if (!product) { console.error('no buyable product found'); process.exit(1) }
  console.log(`[verify-h0a] target product: ${product.sku}`)

  // 1. Create supplier
  const supplierRes = await api('POST', '/api/fulfillment/suppliers', {
    name: `${TEST_TAG} Supplier`,
    notes: 'verify-h0a test fixture — auto-deleted',
  })
  if (!supplierRes.ok) { bad('create supplier', JSON.stringify(supplierRes.data)); throw new Error('halt') }
  supplierId = supplierRes.data.id ?? supplierRes.data?.supplier?.id
  if (!supplierId) { bad('supplier id missing', JSON.stringify(supplierRes.data)); throw new Error('halt') }
  ok('create supplier')

  // 2. Create PO with single line, 10 units
  const poRes = await api('POST', '/api/fulfillment/purchase-orders', {
    supplierId,
    items: [
      { productId: product.id, sku: product.sku, quantityOrdered: 10, unitCostCents: 1000 },
    ],
  })
  if (!poRes.ok) { bad('create PO', JSON.stringify(poRes.data)); throw new Error('halt') }
  poId = poRes.data.id ?? poRes.data?.purchaseOrder?.id
  if (!poId) { bad('PO id missing', JSON.stringify(poRes.data)); throw new Error('halt') }
  ok('create PO')

  // 3. Submit PO
  const submitRes = await api('POST', `/api/fulfillment/purchase-orders/${poId}/submit`, {})
  if (submitRes.ok) ok('submit PO')
  else bad('submit PO', JSON.stringify(submitRes.data))

  // 4. Create inbound from PO
  const recvRes = await api('POST', `/api/fulfillment/purchase-orders/${poId}/receive`, {})
  if (!recvRes.ok) { bad('PO /receive (create inbound)', JSON.stringify(recvRes.data)); throw new Error('halt') }
  inboundId = recvRes.data.inboundShipmentId
  ok('PO /receive created inbound')

  // 4a. Verify FK was set
  const fkCheck = await client.query(`
    SELECT id, "purchaseOrderItemId"
    FROM "InboundShipmentItem"
    WHERE "inboundShipmentId" = $1
  `, [inboundId])
  if (fkCheck.rows[0]?.purchaseOrderItemId) ok('InboundShipmentItem.purchaseOrderItemId set on PO-driven create')
  else { bad('FK not set', JSON.stringify(fkCheck.rows[0])); throw new Error('halt') }
  inboundItemId = fkCheck.rows[0].id

  // 5. Receive partial (5 of 10) → PO should go DRAFT/SUBMITTED → PARTIAL
  const partial = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 5 }],
  })
  if (!partial.ok) bad('partial receive', JSON.stringify(partial.data))
  else ok('partial receive returns 200')

  const after5 = await client.query(`
    SELECT po.status::text as status, poi."quantityReceived" as received
    FROM "PurchaseOrder" po
    JOIN "PurchaseOrderItem" poi ON poi."purchaseOrderId" = po.id
    WHERE po.id = $1
  `, [poId])
  if (after5.rows[0]?.status === 'PARTIAL') ok('PO transitioned to PARTIAL')
  else bad('PO status after partial', JSON.stringify(after5.rows[0]))
  if (after5.rows[0]?.received === 5) ok('PO line quantityReceived = 5')
  else bad('PO line quantityReceived', JSON.stringify(after5.rows[0]))

  // 6. Receive remainder (cumulative 10) → PARTIAL → RECEIVED
  // Existing receive flow OVERWRITES quantityReceived (Bug 0b will fix
  // this; here we test 0a behavior under the existing semantics).
  const final = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 10 }],
  })
  if (!final.ok) bad('final receive', JSON.stringify(final.data))
  else ok('final receive returns 200')

  const after10 = await client.query(`
    SELECT po.status::text as status, poi."quantityReceived" as received
    FROM "PurchaseOrder" po
    JOIN "PurchaseOrderItem" poi ON poi."purchaseOrderId" = po.id
    WHERE po.id = $1
  `, [poId])
  if (after10.rows[0]?.status === 'RECEIVED') ok('PO transitioned to RECEIVED')
  else bad('PO status after final', JSON.stringify(after10.rows[0]))
  if (after10.rows[0]?.received === 10) ok('PO line quantityReceived = 10')
  else bad('PO line quantityReceived', JSON.stringify(after10.rows[0]))

  // 7. No-downgrade: re-receive with lower qty (5) — PO stays RECEIVED
  await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 5 }],
  })
  const afterReverse = await client.query(`SELECT status::text FROM "PurchaseOrder" WHERE id = $1`, [poId])
  if (afterReverse.rows[0]?.status === 'RECEIVED') ok('PO stays RECEIVED (no-downgrade guard)')
  else bad('PO downgrade not blocked', JSON.stringify(afterReverse.rows[0]))
} finally {
  await cleanup()
  await client.end()
  console.log(`\n[verify-h0a] PASS=${pass} FAIL=${fail}`)
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
    process.exit(1)
  }
}
