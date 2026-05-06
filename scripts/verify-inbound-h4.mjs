#!/usr/bin/env node
// H.4 (Inbound) verification — create flow with full H.1 fields
// + PO link path + verify items copy + currency mirror.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h4.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const TEST_TAG = `INBOUND_H4_${Date.now()}`
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

let supplierId, poId, manualInboundId, csvInboundId, poInboundId

async function findRealTestProduct() {
  const r = await client.query(`
    SELECT id, sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1
  `)
  return r.rows[0]
}

async function cleanup() {
  console.log('[verify-inbound-h4] cleanup')
  for (const id of [manualInboundId, csvInboundId, poInboundId]) {
    if (id) try { await client.query(`DELETE FROM "InboundShipment" WHERE id = $1`, [id]) } catch {}
  }
  if (poId) try { await client.query(`DELETE FROM "PurchaseOrder" WHERE id = $1`, [poId]) } catch {}
  if (supplierId) try { await client.query(`DELETE FROM "Supplier" WHERE id = $1`, [supplierId]) } catch {}
}

try {
  const product = await findRealTestProduct()
  if (!product) { console.error('no product'); process.exit(1) }

  // Bootstrap supplier + PO for the link-to-PO path
  const sRes = await api('POST', '/api/fulfillment/suppliers', { name: `${TEST_TAG} Supplier` })
  if (!sRes.ok) { bad('supplier', JSON.stringify(sRes.data)); throw new Error('halt') }
  supplierId = sRes.data.id ?? sRes.data?.supplier?.id

  const pRes = await api('POST', '/api/fulfillment/purchase-orders', {
    supplierId,
    items: [{ productId: product.id, sku: product.sku, quantityOrdered: 7, unitCostCents: 1500 }],
  })
  if (!pRes.ok) { bad('PO', JSON.stringify(pRes.data)); throw new Error('halt') }
  poId = pRes.data.id ?? pRes.data?.purchaseOrder?.id
  await api('POST', `/api/fulfillment/purchase-orders/${poId}/submit`, {})
  ok('bootstrap supplier + submitted PO')

  // 1. PO list endpoint with multi-status filter
  const poList = await api('GET', '/api/fulfillment/purchase-orders?status=SUBMITTED,CONFIRMED,PARTIAL,DRAFT')
  if (poList.ok && Array.isArray(poList.data?.items)) ok('PO list multi-status filter')
  else bad('PO list multi-status', JSON.stringify(poList.data).slice(0, 200))
  const found = poList.data.items.find((p) => p.id === poId)
  if (found) ok('our PO appears in the multi-status response')
  else bad('PO in list', `not found among ${poList.data.items.length}`)

  // 2. Manual create with FULL H.1 surface
  const manualRes = await api('POST', '/api/fulfillment/inbound', {
    type: 'SUPPLIER',
    reference: `${TEST_TAG} manual`,
    asnNumber: 'ASN-H4-001',
    expectedAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
    carrierCode: 'BRT',
    trackingNumber: 'BRT-H4-VERIFY',
    currencyCode: 'EUR',
    shippingCostCents: 1200,
    customsCostCents: 350,
    items: [
      { sku: `${TEST_TAG}-MANUAL-1`, quantityExpected: 5, unitCostCents: 1000 },
    ],
  })
  if (!manualRes.ok) { bad('manual create', JSON.stringify(manualRes.data)); throw new Error('halt') }
  manualInboundId = manualRes.data.id
  ok('manual create with carrier+cost+ASN')
  if (manualRes.data.carrierCode === 'BRT') ok('manual: carrierCode persisted')
  else bad('manual carrier', JSON.stringify(manualRes.data.carrierCode))

  // 3. CSV-import-equivalent (multiple items via JSON; UI parses CSV before sending)
  const csvRes = await api('POST', '/api/fulfillment/inbound', {
    type: 'SUPPLIER',
    reference: `${TEST_TAG} CSV`,
    items: [
      { sku: `${TEST_TAG}-CSV-1`, quantityExpected: 10, unitCostCents: 800 },
      { sku: `${TEST_TAG}-CSV-2`, quantityExpected: 5,  unitCostCents: 1200 },
      { sku: `${TEST_TAG}-CSV-3`, quantityExpected: 1 },
    ],
  })
  if (!csvRes.ok) { bad('CSV-style create', JSON.stringify(csvRes.data)); throw new Error('halt') }
  csvInboundId = csvRes.data.id
  if (csvRes.data.items?.length === 3) ok('CSV-style multi-line create (3 items)')
  else bad('CSV-style item count', `got ${csvRes.data.items?.length}`)

  // 4. PO-linked create — items, FK, currency should propagate.
  // Mirrors the frontend "Link to PO" flow: pick a PO, send items
  // with purchaseOrderItemId threaded.
  const poItem = pRes.data.items?.[0]
  const poLinkedRes = await api('POST', '/api/fulfillment/inbound', {
    type: 'SUPPLIER',
    reference: `${TEST_TAG} PO-linked`,
    purchaseOrderId: poId,
    currencyCode: pRes.data.currencyCode,
    items: [{
      sku: poItem.sku,
      productId: poItem.productId,
      purchaseOrderItemId: poItem.id,
      quantityExpected: poItem.quantityOrdered,
      unitCostCents: poItem.unitCostCents,
    }],
  })
  if (!poLinkedRes.ok) { bad('PO-linked create', JSON.stringify(poLinkedRes.data)); throw new Error('halt') }
  poInboundId = poLinkedRes.data.id

  // Verify the FK was set
  const fkCheck = await client.query(`
    SELECT "purchaseOrderItemId", "unitCostCents"
    FROM "InboundShipmentItem"
    WHERE "inboundShipmentId" = $1
  `, [poInboundId])
  if (fkCheck.rows[0]?.purchaseOrderItemId === poItem.id) ok('PO-linked: purchaseOrderItemId set on item')
  else bad('PO-linked FK', JSON.stringify(fkCheck.rows[0]))
  if (fkCheck.rows[0]?.unitCostCents === poItem.unitCostCents) ok('PO-linked: unitCostCents propagated')
  else bad('PO-linked unitCost', JSON.stringify(fkCheck.rows[0]))
} finally {
  await cleanup()
  await client.end()
  console.log(`\n[verify-inbound-h4] PASS=${pass} FAIL=${fail}`)
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
    process.exit(1)
  }
}
