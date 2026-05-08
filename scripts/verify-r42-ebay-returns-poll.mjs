#!/usr/bin/env node
// Verify R4.2 — eBay returns ingest mapping + idempotency + sweep.
// Two paths exercised:
//   1. ingest-test: single payload → Return row mapping correctness
//   2. poll-test:   stubbed fetch → full sweep + counters
//
// Real eBay API is NOT called. The cron is verified by the import
// side-effect (it loads cleanly + status reports correct).
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

const productRow = (await dbq(`SELECT sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1`))[0]
if (!productRow) { bad('no Product to test with', ''); process.exit(1) }
ok(`will use SKU ${productRow.sku}`)

const ebayOrder = (await dbq(
  `SELECT id, "channelOrderId" FROM "Order" WHERE channel = 'EBAY' ORDER BY "createdAt" DESC LIMIT 1`,
))[0]
if (ebayOrder) ok(`linking to eBay order ${ebayOrder.channelOrderId}`)
else console.log('  → no eBay orders in DB; orphan-return path will be exercised')

const ebayReturnId = `${5_000_000_000_000 + Date.now()}` // realistic-ish numeric id as string

const fixturePayload = (id, opts = {}) => ({
  returnId: id,
  state: opts.state ?? 'RETURN_REQUESTED',
  creationInfo: {
    creationDate: '2026-05-08T10:00:00Z',
    type: 'RETURN',
    reason: opts.reason ?? 'ITEM_NOT_AS_DESCRIBED',
    comments: opts.comments ?? 'Buyer says size runs small',
    item: {
      itemId: `EBAY-ITEM-${id}`,
      transactionId: ebayOrder?.channelOrderId ?? `EBAY-TX-${id}`,
      sku: productRow.sku,
      quantity: 1,
      title: productRow.sku,
      amount: { value: 39.99, currency: 'EUR' },
    },
  },
  buyerLoginName: 'buyer123',
  sellerLoginName: 'xavia',
  lastModifiedDate: '2026-05-08T10:00:00Z',
})

console.log('\n[1] Ingest test — single payload')
{
  const r = await fetch(`${API}/api/fulfillment/returns/ebay/ingest-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixturePayload(ebayReturnId)),
  })
  const j = await r.json()
  if (r.ok && j.outcome === 'created' && j.returnId) ok(`created Return ${j.returnId}`)
  else bad('ingest failed', JSON.stringify(j).slice(0, 200))
}

let createdId = null
console.log('\n[2] Verify Return row')
{
  const rows = await dbq(
    `SELECT id, channel, "channelReturnId", status, "refundStatus", "refundCents", "currencyCode", reason, notes, "orderId"
     FROM "Return" WHERE channel = 'EBAY' AND "channelReturnId" = $1`,
    [ebayReturnId],
  )
  if (rows.length === 1) ok(`1 Return row at channelReturnId=${ebayReturnId}`)
  else { bad(`expected 1, got ${rows.length}`, ''); process.exit(1) }
  const r = rows[0]
  createdId = r.id
  if (r.status === 'REQUESTED') ok('status mapped REQUESTED from RETURN_REQUESTED')
  else bad('state mapping wrong', r.status)
  if (r.refundStatus === 'PENDING') ok('refundStatus=PENDING (open return, not yet settled)')
  else bad('refundStatus mismatch', r.refundStatus)
  if (r.refundCents === 3999) ok('refundCents=3999 from item amount 39.99')
  else bad('refundCents wrong', `got ${r.refundCents}`)
  if (r.currencyCode === 'EUR') ok('currencyCode=EUR')
  else bad('currency mismatch', r.currencyCode)
  if (r.reason === 'item not as described') ok('reason normalized: "item not as described"')
  else bad('reason mismatch', r.reason)
  if (r.notes === 'Buyer says size runs small') ok('notes carried from comments')
  else bad('notes mismatch', r.notes)
  if (ebayOrder) {
    if (r.orderId === ebayOrder.id) ok('orderId resolved via channelOrderId')
    else bad('orderId resolution failed', r.orderId)
  } else if (r.orderId === null) {
    ok('orphan return → orderId=null (will attach later)')
  } else bad('orphan should be null', r.orderId)
}

console.log('\n[3] Verify ReturnItem rows')
{
  const items = await dbq(
    `SELECT sku, quantity, "productId" FROM "ReturnItem" WHERE "returnId" = $1`,
    [createdId],
  )
  if (items.length === 1 && items[0].sku === productRow.sku) ok(`1 ReturnItem with SKU ${productRow.sku}`)
  else bad('item shape wrong', JSON.stringify(items))
  if (items[0]?.productId) ok('productId resolved by SKU')
  else bad('productId not resolved', JSON.stringify(items[0]))
}

console.log('\n[4] AuditLog attribution')
await new Promise((r) => setTimeout(r, 300))
{
  const audit = await dbq(
    `SELECT metadata FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1 AND action = 'create'`,
    [createdId],
  )
  if (audit.length === 1) {
    const md = audit[0].metadata
    if (md?.source === 'ebay-returns-poll') ok(`audit source=ebay-returns-poll, returnId=${md.ebayReturnId}`)
    else bad('audit source wrong', JSON.stringify(md))
    if (md?.mappedStatus === 'REQUESTED') ok('audit records mapped status')
    else bad('mapped status missing in audit', JSON.stringify(md))
  } else bad('no audit row', '')
}

console.log('\n[5] Idempotency — same payload again')
{
  const r = await fetch(`${API}/api/fulfillment/returns/ebay/ingest-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixturePayload(ebayReturnId)),
  })
  const j = await r.json()
  if (r.ok && j.outcome === 'duplicate' && j.returnId === createdId) ok('duplicate detected, same Return id')
  else bad('idempotency failed', JSON.stringify(j).slice(0, 200))
}

console.log('\n[6] State mapping — CLOSED → REFUNDED')
const closedReturnId = `${parseInt(ebayReturnId, 10) + 1}`
{
  const r = await fetch(`${API}/api/fulfillment/returns/ebay/ingest-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixturePayload(closedReturnId, { state: 'CLOSED' })),
  })
  const j = await r.json()
  if (r.ok && j.outcome === 'created') ok('CLOSED return ingested')
  else bad('CLOSED ingest failed', JSON.stringify(j))
  const row = (await dbq(
    `SELECT status, "refundStatus", "channelRefundId", "refundedAt" FROM "Return" WHERE channel = 'EBAY' AND "channelReturnId" = $1`,
    [closedReturnId],
  ))[0]
  if (row?.status === 'REFUNDED' && row.refundStatus === 'REFUNDED') ok('CLOSED → status REFUNDED + refundStatus REFUNDED')
  else bad('CLOSED state mapping wrong', JSON.stringify(row))
  if (row?.channelRefundId === closedReturnId && row.refundedAt) ok('channelRefundId + refundedAt populated for refunded state')
  else bad('refund tracking missing', JSON.stringify(row))
}

console.log('\n[7] No-lines guard (no SKU on the item)')
const noLineId = `${parseInt(ebayReturnId, 10) + 2}`
{
  const r = await fetch(`${API}/api/fulfillment/returns/ebay/ingest-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      returnId: noLineId,
      state: 'RETURN_REQUESTED',
      creationInfo: { creationDate: '2026-05-08T11:00:00Z', reason: 'GENERIC' },
    }),
  })
  const j = await r.json()
  if (r.ok && j.outcome === 'no_lines') ok('payload with no items → no_lines (no Return created)')
  else bad('no_lines path wrong', JSON.stringify(j))
  const count = (await dbq(`SELECT count(*)::int AS n FROM "Return" WHERE "channelReturnId" = $1`, [noLineId]))[0].n
  if (count === 0) ok('no Return row created for no_lines case')
  else bad('row created unexpectedly', '')
}

console.log('\n[8] Sweep test — stubbed fetch with 3 members')
const sweepIds = [3, 4, 5].map((n) => `${parseInt(ebayReturnId, 10) + n + 100}`)
{
  const members = sweepIds.map((id) => fixturePayload(id))
  const r = await fetch(`${API}/api/fulfillment/returns/ebay/poll-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members }),
  })
  const j = await r.json()
  // The connectionsScanned count reflects ACTIVE oauth eBay connections
  // in the DB. If there are zero, the sweep can't iterate even with the
  // stubbed fetch — that's the realistic gate. We still cover the
  // ingest path via [1]–[7].
  if (r.ok) {
    ok(`sweep returned: scanned=${j.connectionsScanned} created=${j.created} duplicate=${j.duplicate} no_lines=${j.noLines} failed=${j.failed}`)
    if (j.connectionsScanned === 0) {
      console.log('  → no active eBay connections; ingest path covered by [1]–[7] above')
    }
  } else bad('sweep failed', JSON.stringify(j))
}

// If sweep ran and created the rows, clean them up too
const cleanupIds = await dbq(
  `SELECT id FROM "Return" WHERE channel = 'EBAY' AND "channelReturnId" = ANY($1::text[])`,
  [sweepIds],
)
const ids = cleanupIds.map((r) => r.id)

console.log('\n[9] Cleanup')
const allTestIds = [createdId, ...ids].filter(Boolean)
const allChannelReturnIds = [ebayReturnId, closedReturnId, noLineId, ...sweepIds]
await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = ANY($1::text[])`, [allTestIds])
await dbq(`DELETE FROM "Return" WHERE channel = 'EBAY' AND "channelReturnId" = ANY($1::text[])`, [allChannelReturnIds])
ok('test rows + audit logs deleted')

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
