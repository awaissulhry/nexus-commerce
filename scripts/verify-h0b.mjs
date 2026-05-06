#!/usr/bin/env node
// H.0b end-to-end verification. Asserts:
//   - cumulative-target semantics dedupe double-receive
//   - explicit idempotencyKey dedupes retries
//   - reversal (lower target) writes negative event
//   - InboundShipmentItem.quantityReceived = SUM(InboundReceipt.quantity)
//   - PO state from H.0a still propagates correctly
//
// Self-cleaning fixture. Cascades on InboundShipment delete.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-h0b.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const TEST_TAG = `H0B_VERIFY_${Date.now()}`
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

async function eventCount() {
  const r = await client.query(
    `SELECT count(*)::int as n FROM "InboundReceipt" WHERE "inboundShipmentItemId" = $1`,
    [inboundItemId],
  )
  return r.rows[0].n
}
async function itemReceived() {
  const r = await client.query(
    `SELECT "quantityReceived" FROM "InboundShipmentItem" WHERE id = $1`,
    [inboundItemId],
  )
  return r.rows[0].quantityReceived
}

async function cleanup() {
  console.log('[verify-h0b] cleanup')
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
  console.log(`[verify-h0b] target product: ${product.sku}`)

  // Bootstrap supplier + PO + inbound (relies on H.0a working).
  const supplierRes = await api('POST', '/api/fulfillment/suppliers', {
    name: `${TEST_TAG} Supplier`,
    notes: 'verify-h0b test fixture — auto-deleted',
  })
  if (!supplierRes.ok) { bad('create supplier', JSON.stringify(supplierRes.data)); throw new Error('halt') }
  supplierId = supplierRes.data.id ?? supplierRes.data?.supplier?.id
  ok('create supplier')

  const poRes = await api('POST', '/api/fulfillment/purchase-orders', {
    supplierId,
    items: [{ productId: product.id, sku: product.sku, quantityOrdered: 20, unitCostCents: 1000 }],
  })
  if (!poRes.ok) { bad('create PO', JSON.stringify(poRes.data)); throw new Error('halt') }
  poId = poRes.data.id ?? poRes.data?.purchaseOrder?.id
  ok('create PO')

  await api('POST', `/api/fulfillment/purchase-orders/${poId}/submit`, {})

  const recvRes = await api('POST', `/api/fulfillment/purchase-orders/${poId}/receive`, {})
  inboundId = recvRes.data.inboundShipmentId

  const itemRow = await client.query(
    `SELECT id FROM "InboundShipmentItem" WHERE "inboundShipmentId" = $1`,
    [inboundId],
  )
  inboundItemId = itemRow.rows[0].id
  ok('bootstrap PO + inbound from H.0a')

  // 1. Receive 5 (no key) — first event.
  const r1 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 5 }],
  })
  if (r1.ok) ok('receive 5 — returns 200')
  else bad('receive 5', JSON.stringify(r1.data))
  if (await eventCount() === 1) ok('event count = 1 after first receive')
  else bad('event count after r1', `got ${await eventCount()}`)
  if (await itemReceived() === 5) ok('item.quantityReceived = 5')
  else bad('item received after r1', `got ${await itemReceived()}`)

  // 2. Receive 5 again (no key) — cumulative-semantics dedup.
  const r2 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 5 }],
  })
  if (r2.ok) ok('receive 5 again — returns 200')
  else bad('receive 5 again', JSON.stringify(r2.data))
  if (await eventCount() === 1) ok('cumulative dedup: still 1 event after duplicate receive')
  else bad('cumulative dedup', `got ${await eventCount()} events`)
  if (await itemReceived() === 5) ok('item.quantityReceived still 5 (no double-stock)')
  else bad('item received after r2', `got ${await itemReceived()}`)

  // 3. Receive 10 with idempotencyKey="abc" — second event for delta=5.
  const r3 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 10, idempotencyKey: 'abc' }],
  })
  if (r3.ok) ok('receive 10 with key=abc — returns 200')
  else bad('receive 10', JSON.stringify(r3.data))
  if (await eventCount() === 2) ok('event count = 2 after delta=5 with key')
  else bad('event count after r3', `got ${await eventCount()}`)
  if (await itemReceived() === 10) ok('item.quantityReceived = 10')
  else bad('item received after r3', `got ${await itemReceived()}`)

  // 4. Re-POST the same key=abc — explicit retry dedupe.
  const r4 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 10, idempotencyKey: 'abc' }],
  })
  if (r4.ok && await eventCount() === 2) ok('idempotencyKey dedup: same target + same key = no new event')
  else bad('idempotencyKey dedup', `events=${await eventCount()}`)

  // 5. Re-POST DIFFERENT target with same key=abc — key wins, no new event.
  const r5 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 12, idempotencyKey: 'abc' }],
  })
  const after5 = await eventCount()
  const item5 = await itemReceived()
  if (after5 === 2 && item5 === 10) ok('idempotencyKey dedup wins over cumulative target (key=abc still no new event)')
  else bad('key wins over target', `events=${after5} item=${item5}`)

  // 6. Receive 12 with NEW key="def" — third event for delta=2.
  const r6 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 12, idempotencyKey: 'def' }],
  })
  if (r6.ok && await eventCount() === 3) ok('new key key=def writes new event for delta=2')
  else bad('new key event', `events=${await eventCount()}`)
  if (await itemReceived() === 12) ok('item.quantityReceived = 12')
  else bad('item received after r6', `got ${await itemReceived()}`)

  // 7. Reverse to 8 (no key) — negative-quantity event.
  const r7 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 8 }],
  })
  if (r7.ok && await eventCount() === 4) ok('reversal writes negative-quantity event')
  else bad('reversal event', `events=${await eventCount()}`)
  if (await itemReceived() === 8) ok('item.quantityReceived = 8 after reversal')
  else bad('item received after r7', `got ${await itemReceived()}`)

  // 8. Invariant: SUM(events.quantity) = item.quantityReceived
  const sumRow = await client.query(
    `SELECT COALESCE(SUM(quantity),0)::int as s FROM "InboundReceipt" WHERE "inboundShipmentItemId" = $1`,
    [inboundItemId],
  )
  if (sumRow.rows[0].s === 8) ok('invariant SUM(events) = item.quantityReceived = 8')
  else bad('invariant', `sum=${sumRow.rows[0].s} item=${await itemReceived()}`)

  // 9. PO state from H.0a still works: PO.quantityReceived = 8, status = PARTIAL
  const poState = await client.query(`
    SELECT po.status::text as status, poi."quantityReceived" as received
    FROM "PurchaseOrder" po
    JOIN "PurchaseOrderItem" poi ON poi."purchaseOrderId" = po.id
    WHERE po.id = $1
  `, [poId])
  if (poState.rows[0]?.received === 8) ok('H.0a PO line quantityReceived = 8 (propagation intact)')
  else bad('H.0a PO line', JSON.stringify(poState.rows[0]))
  if (poState.rows[0]?.status === 'PARTIAL') ok('H.0a PO status = PARTIAL (no-downgrade kept it; was RECEIVED at qty 12)')
  else if (poState.rows[0]?.status === 'RECEIVED') ok('H.0a PO status = RECEIVED (no-downgrade preserved earlier RECEIVED)')
  else bad('H.0a PO status', JSON.stringify(poState.rows[0]))
} finally {
  await cleanup()
  await client.end()
  console.log(`\n[verify-h0b] PASS=${pass} FAIL=${fail}`)
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
    process.exit(1)
  }
}
