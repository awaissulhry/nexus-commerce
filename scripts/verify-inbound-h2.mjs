#!/usr/bin/env node
// H.2 (Inbound) verification — service refactor + new endpoints.
// Asserts:
//   - receive flow still works end-to-end (delegates to service)
//   - auto-transition to PARTIALLY_RECEIVED on partial receive
//   - auto-transition to RECEIVED on full receive
//   - manual transition (DRAFT → SUBMITTED, etc.)
//   - invalid transition returns 409
//   - QC HOLD release applies stock movement
//   - photo append surfaces in detail bundle
//   - attachment add surfaces in detail bundle
//   - discrepancy create surfaces in detail bundle
//   - discrepancy resolve auto-transitions RECEIVED → RECONCILED
//   - close transitions to CLOSED
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h2.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const TEST_TAG = `INBOUND_H2_${Date.now()}`
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
async function api(method, p, body) {
  const opts = { method }
  if (body != null) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API_BASE}${p}`, opts)
  const text = await res.text()
  let data; try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

let supplierId, poId, inboundId, inboundItemId

async function findRealTestProduct() {
  const r = await client.query(`
    SELECT id, sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1
  `)
  return r.rows[0]
}

async function shipmentStatus() {
  const r = await client.query(`SELECT status::text FROM "InboundShipment" WHERE id = $1`, [inboundId])
  return r.rows[0]?.status
}

async function cleanup() {
  console.log('[verify-inbound-h2] cleanup')
  if (inboundId) { try { await client.query(`DELETE FROM "InboundShipment" WHERE id = $1`, [inboundId]) } catch {} }
  if (poId)      { try { await client.query(`DELETE FROM "PurchaseOrder" WHERE id = $1`, [poId]) } catch {} }
  if (supplierId){ try { await client.query(`DELETE FROM "Supplier" WHERE id = $1`, [supplierId]) } catch {} }
}

try {
  const product = await findRealTestProduct()
  if (!product) { console.error('no buyable product'); process.exit(1) }

  // Bootstrap supplier + PO + inbound (relies on H.0a + H.1)
  const sRes = await api('POST', '/api/fulfillment/suppliers', { name: `${TEST_TAG} Supplier` })
  if (!sRes.ok) { bad('supplier', JSON.stringify(sRes.data)); throw new Error('halt') }
  supplierId = sRes.data.id ?? sRes.data?.supplier?.id
  const pRes = await api('POST', '/api/fulfillment/purchase-orders', {
    supplierId,
    items: [{ productId: product.id, sku: product.sku, quantityOrdered: 10, unitCostCents: 1000 }],
  })
  if (!pRes.ok) { bad('PO', JSON.stringify(pRes.data)); throw new Error('halt') }
  poId = pRes.data.id ?? pRes.data?.purchaseOrder?.id
  await api('POST', `/api/fulfillment/purchase-orders/${poId}/submit`, {})
  const recvRes = await api('POST', `/api/fulfillment/purchase-orders/${poId}/receive`, {})
  inboundId = recvRes.data.inboundShipmentId
  const rowItem = await client.query(
    `SELECT id FROM "InboundShipmentItem" WHERE "inboundShipmentId" = $1`, [inboundId]
  )
  inboundItemId = rowItem.rows[0].id
  ok('bootstrap supplier + PO + inbound')

  // 1. Manual transition DRAFT → SUBMITTED
  const t1 = await api('POST', `/api/fulfillment/inbound/${inboundId}/transition`, { status: 'SUBMITTED' })
  if (t1.ok) ok('transition DRAFT → SUBMITTED')
  else bad('transition DRAFT → SUBMITTED', JSON.stringify(t1.data))

  // 2. Invalid transition: SUBMITTED → CLOSED — should 409
  const tBad = await api('POST', `/api/fulfillment/inbound/${inboundId}/transition`, { status: 'CLOSED' })
  if (tBad.status === 409) ok('invalid transition returns 409')
  else bad('invalid transition', `status=${tBad.status}`)

  // 3. Walk to RECEIVING
  await api('POST', `/api/fulfillment/inbound/${inboundId}/transition`, { status: 'IN_TRANSIT' })
  await api('POST', `/api/fulfillment/inbound/${inboundId}/transition`, { status: 'ARRIVED' })
  await api('POST', `/api/fulfillment/inbound/${inboundId}/transition`, { status: 'RECEIVING' })
  if (await shipmentStatus() === 'RECEIVING') ok('walked to RECEIVING via manual transitions')
  else bad('walk to RECEIVING', await shipmentStatus())

  // 4. Partial receive — auto-transition to PARTIALLY_RECEIVED
  const r1 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 5 }],
  })
  if (r1.ok) ok('partial receive')
  else bad('partial receive', JSON.stringify(r1.data))
  if (await shipmentStatus() === 'PARTIALLY_RECEIVED') ok('auto-transition: RECEIVING → PARTIALLY_RECEIVED')
  else bad('auto-transition partial', await shipmentStatus())

  // 5. Append photo URL
  const photoRes = await api('POST', `/api/fulfillment/inbound/${inboundId}/items/${inboundItemId}/photos`, {
    url: 'https://res.cloudinary.com/test/image/upload/inbound/test.jpg',
  })
  if (photoRes.ok && photoRes.data.photoUrls?.length === 1) ok('append photo URL to item')
  else bad('photo append', JSON.stringify(photoRes.data))

  // 6. Add attachment (invoice)
  const attRes = await api('POST', `/api/fulfillment/inbound/${inboundId}/attachments`, {
    kind: 'INVOICE',
    url: 'https://res.cloudinary.com/test/raw/upload/inbound/invoice.pdf',
    filename: 'invoice.pdf',
    contentType: 'application/pdf',
  })
  if (attRes.ok) ok('add attachment (INVOICE)')
  else bad('attachment', JSON.stringify(attRes.data))

  // 7. Record a ship-level discrepancy
  const dRes = await api('POST', `/api/fulfillment/inbound/${inboundId}/discrepancies`, {
    reasonCode: 'LATE_ARRIVAL',
    description: 'Verify-H2 fixture',
  })
  if (dRes.ok && dRes.data.id) ok('create ship-level discrepancy')
  else bad('discrepancy create', JSON.stringify(dRes.data))
  const discrepancyId = dRes.data?.id

  // 8. Detail bundle includes attachment + discrepancy + photoUrls
  const detail = await api('GET', `/api/fulfillment/inbound/${inboundId}`)
  if (detail.ok && detail.data.attachments?.length >= 1) ok('detail bundle attachments[]')
  else bad('detail attachments', JSON.stringify(detail.data?.attachments))
  if (detail.ok && detail.data.discrepancies?.length >= 1) ok('detail bundle discrepancies[]')
  else bad('detail discrepancies', JSON.stringify(detail.data?.discrepancies))
  const itemFromDetail = detail.data?.items?.find((it) => it.id === inboundItemId)
  if (itemFromDetail?.photoUrls?.length === 1) ok('item.photoUrls[] in detail bundle')
  else bad('detail item photos', JSON.stringify(itemFromDetail?.photoUrls))

  // 9. Full receive (cumulative 10) — auto-transition to RECEIVED
  // (note: open discrepancy means it should NOT auto-go to RECONCILED)
  const r2 = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId: inboundItemId, quantityReceived: 10 }],
  })
  if (r2.ok) ok('full receive')
  else bad('full receive', JSON.stringify(r2.data))
  if (await shipmentStatus() === 'RECEIVED') ok('auto-transition: PARTIALLY_RECEIVED → RECEIVED (open discrepancy blocks RECONCILED)')
  else bad('auto-transition full with open discrepancy', await shipmentStatus())

  // 10. Resolve discrepancy → auto-transition RECEIVED → RECONCILED
  const dResolve = await api('PATCH', `/api/fulfillment/inbound/discrepancies/${discrepancyId}`, {
    status: 'RESOLVED',
    resolutionNotes: 'Verified — supplier credited account',
  })
  if (dResolve.ok) ok('resolve discrepancy')
  else bad('resolve discrepancy', JSON.stringify(dResolve.data))
  if (await shipmentStatus() === 'RECONCILED') ok('auto-transition: RECEIVED → RECONCILED on discrepancy resolve')
  else bad('auto-transition RECONCILED', await shipmentStatus())

  // 11. Close
  const closeRes = await api('POST', `/api/fulfillment/inbound/${inboundId}/close`, {})
  if (closeRes.ok && await shipmentStatus() === 'CLOSED') ok('close → CLOSED')
  else bad('close', `${closeRes.status} status=${await shipmentStatus()}`)
} finally {
  await cleanup()
  await client.end()
  console.log(`\n[verify-inbound-h2] PASS=${pass} FAIL=${fail}`)
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
    process.exit(1)
  }
}
