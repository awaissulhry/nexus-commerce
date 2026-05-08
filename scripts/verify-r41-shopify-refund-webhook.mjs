#!/usr/bin/env node
// Verify R4.1 — Shopify refund webhook → Return row.
// Hits the test endpoint (no signature) with a realistic fixture, then
// checks the resulting Return + AuditLog. Idempotency tested by firing
// the same payload twice. Order-link path tested by reusing an existing
// Order's channelOrderId; orphan-refund path tested by using a bogus
// channelOrderId.
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
const bad = (l, d) => { console.log('  ✗', l, '\n    →', d); fail++ }
const dbq = (s, p) => client.query(s, p).then((r) => r.rows)

// Find a real product so the productId resolution path is exercised.
const productRow = (await dbq(`SELECT sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1`))[0]
if (!productRow) { bad('no Product to test with', ''); process.exit(1) }
ok(`will refund SKU ${productRow.sku}`)

// Find a Shopify order if any. If none, we still test the orphan
// path; the handler creates the Return with orderId=null.
const shopifyOrder = (await dbq(
  `SELECT id, "channelOrderId" FROM "Order" WHERE channel = 'SHOPIFY' ORDER BY "createdAt" DESC LIMIT 1`,
))[0]
if (shopifyOrder) ok(`linking to Shopify order ${shopifyOrder.channelOrderId}`)
else console.log('  → no Shopify orders in DB; using bogus channelOrderId (orphan-refund path)')

const refundFixture = (id, orderId) => ({
  id,
  order_id: orderId,
  created_at: '2026-05-08T10:00:00Z',
  note: 'Customer changed their mind',
  refund_line_items: [
    {
      id: id * 10 + 1,
      line_item_id: 999_001,
      quantity: 1,
      subtotal: '29.99',
      subtotal_set: { shop_money: { amount: '29.99', currency_code: 'EUR' } },
      line_item: { id: 999_001, sku: productRow.sku, quantity: 1, price: '29.99', name: productRow.sku },
    },
    {
      id: id * 10 + 2,
      line_item_id: 999_002,
      quantity: 1,
      subtotal: '14.50',
      subtotal_set: { shop_money: { amount: '14.50', currency_code: 'EUR' } },
      line_item: { id: 999_002, sku: 'NONEXISTENT-SKU-R41', quantity: 1, price: '14.50', name: 'Phantom' },
    },
  ],
})

const channelOrderId = shopifyOrder?.channelOrderId ?? `bogus-r41-${Date.now()}`
const refundId = 1_500_000_000_000 + Date.now() // big random-ish numeric id

console.log('\n[1] Fire refunds/create-test')
{
  const r = await fetch(`${API}/webhooks/shopify/refunds/create-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(refundFixture(refundId, channelOrderId)),
  })
  const j = await r.json()
  if (r.ok && j.kind === 'created' && j.returnId) ok(`created Return ${j.returnId}`)
  else bad('handler did not create', JSON.stringify(j).slice(0, 200))
}

let createdId = null
console.log('\n[2] Verify Return row')
{
  const rows = await dbq(
    `SELECT id, "channelReturnId", "channelRefundId", channel, status, "refundStatus", "refundCents", "currencyCode", "refundedAt", "channelRefundedAt", reason, "orderId"
     FROM "Return" WHERE "channelReturnId" = $1 AND channel = 'SHOPIFY'`,
    [String(refundId)],
  )
  if (rows.length === 1) ok(`1 Return row at channelReturnId=${refundId}`)
  else { bad(`expected 1 row, got ${rows.length}`, ''); process.exit(1) }
  const r = rows[0]
  createdId = r.id
  if (r.status === 'REFUNDED' && r.refundStatus === 'REFUNDED') ok('status=REFUNDED, refundStatus=REFUNDED')
  else bad('status mismatch', JSON.stringify(r))
  // 29.99 + 14.50 = 44.49 → 4449 cents
  if (r.refundCents === 4449) ok(`refundCents=4449 (€44.49)`)
  else bad(`refundCents mismatch`, `got ${r.refundCents}`)
  if (r.currencyCode === 'EUR') ok('currencyCode=EUR')
  else bad('currencyCode mismatch', r.currencyCode)
  if (r.channelRefundId === String(refundId) && r.channelRefundedAt) ok('channelRefundId + channelRefundedAt persisted')
  else bad('channel refund tracking missing', JSON.stringify(r))
  if (r.reason === 'Customer changed their mind') ok('note → reason')
  else bad('reason mismatch', r.reason)
  if (shopifyOrder) {
    if (r.orderId === shopifyOrder.id) ok(`orderId resolved to ${shopifyOrder.id}`)
    else bad('orderId resolution failed', r.orderId)
  } else {
    if (r.orderId === null) ok('orphan refund (no order in DB) → orderId=null (will attach later)')
    else bad('orphan should leave orderId null', r.orderId)
  }
}

console.log('\n[3] Verify ReturnItem rows')
{
  const items = await dbq(
    `SELECT sku, quantity, "productId" FROM "ReturnItem" WHERE "returnId" = $1 ORDER BY sku`,
    [createdId],
  )
  if (items.length === 2) ok(`2 ReturnItem rows`)
  else bad(`expected 2 items, got ${items.length}`, JSON.stringify(items))
  const real = items.find((i) => i.sku === productRow.sku)
  const phantom = items.find((i) => i.sku === 'NONEXISTENT-SKU-R41')
  if (real?.productId) ok(`real SKU ${productRow.sku} → productId resolved`)
  else bad('real SKU productId not resolved', JSON.stringify(real))
  if (phantom && phantom.productId === null) ok('phantom SKU has null productId (Product not in catalog)')
  else bad('phantom should have null productId', JSON.stringify(phantom))
}

console.log('\n[4] AuditLog attribution')
await new Promise((r) => setTimeout(r, 300))
{
  const audit = await dbq(
    `SELECT action, metadata FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1 AND action = 'create'`,
    [createdId],
  )
  if (audit.length === 1) {
    const md = audit[0].metadata
    if (md?.source === 'shopify-webhook' && md?.topic === 'refunds/create') ok(`audit attributes to shopify-webhook (refundId=${md.shopifyRefundId})`)
    else bad('audit attribution wrong', JSON.stringify(md))
  } else bad('no audit row', '')
}

console.log('\n[5] Idempotency — fire the same payload again')
{
  const r = await fetch(`${API}/webhooks/shopify/refunds/create-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(refundFixture(refundId, channelOrderId)),
  })
  const j = await r.json()
  if (r.ok && j.kind === 'duplicate' && j.returnId === createdId) ok('second fire returned duplicate, same Return id')
  else bad('duplicate not detected', JSON.stringify(j).slice(0, 200))
  // No second Return row should exist
  const count = (await dbq(
    `SELECT count(*)::int AS n FROM "Return" WHERE "channelReturnId" = $1`,
    [String(refundId)],
  ))[0].n
  if (count === 1) ok('still exactly 1 Return row in DB')
  else bad(`expected 1 row, got ${count}`, '')
}

console.log('\n[6] Edge case: refund with only shipping (no mappable lines)')
{
  const noLines = {
    id: refundId + 1,
    order_id: channelOrderId,
    created_at: '2026-05-08T10:30:00Z',
    note: 'Shipping refund only',
    refund_line_items: [], // empty
  }
  const r = await fetch(`${API}/webhooks/shopify/refunds/create-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(noLines),
  })
  const j = await r.json()
  if (r.ok && j.kind === 'no_lines') ok('shipping-only refund correctly skipped (no_lines)')
  else bad('shipping-only handling wrong', JSON.stringify(j).slice(0, 200))
  // Confirm no Return row was created for this refund id
  const count = (await dbq(
    `SELECT count(*)::int AS n FROM "Return" WHERE "channelReturnId" = $1`,
    [String(refundId + 1)],
  ))[0].n
  if (count === 0) ok('no Return row created for empty-lines refund')
  else bad('empty-lines created a row', '')
}

console.log('\n[7] Production route is signature-gated')
{
  const r = await fetch(`${API}/webhooks/shopify/refunds/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' /* no x-shopify-hmac-sha256 */ },
    body: JSON.stringify({ id: 999_999 }),
  })
  if (r.status === 400 || r.status === 401) ok(`unsigned production POST → ${r.status}`)
  else bad(`expected 400/401, got ${r.status}`, await r.text().then(t => t.slice(0, 120)))
}

// Cleanup
console.log('\n[8] Cleanup')
await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1`, [createdId])
await dbq(`DELETE FROM "Return" WHERE "channelReturnId" IN ($1, $2)`, [String(refundId), String(refundId + 1)])
ok('test rows deleted')

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
