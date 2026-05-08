#!/usr/bin/env node
// Verify R5.1 — Refund + RefundAttempt rows + write-through cache.
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
ok(`using SKU ${productRow.sku}`)

// Need an Amazon order so the refund-publisher path doesn't bail
// for missing Order linkage. Skip-channel path doesn't need Order
// (the publisher isn't called).
console.log('\n[1] Seed return for skip-channel test')
const create1 = await fetch(`${API}/api/fulfillment/returns`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-user-id': 'r51-verify' },
  body: JSON.stringify({
    channel: 'AMAZON',
    reason: 'R51_SKIP',
    items: [{ sku: productRow.sku, quantity: 1 }],
  }),
})
const ret1 = await create1.json()
ok(`created Return ${ret1.id}`)

console.log('\n[2] Skip-channel refund creates Refund + Attempt rows')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${ret1.id}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'r51-verify' },
    body: JSON.stringify({ refundCents: 2500, skipChannelPush: true }),
  })
  const j = await r.json()
  if (r.ok && j.channelOutcome === 'SKIPPED' && j.refundId) ok(`SKIPPED refund created (refundId=${j.refundId})`)
  else { bad('skip-channel response wrong', JSON.stringify(j)); process.exit(1) }
}
{
  const refunds = await dbq(`SELECT id, "amountCents", "channelStatus", "channelPostedAt" FROM "Refund" WHERE "returnId" = $1`, [ret1.id])
  if (refunds.length === 1) ok('1 Refund row')
  else bad(`expected 1, got ${refunds.length}`, JSON.stringify(refunds))
  const r = refunds[0]
  if (r.channelStatus === 'POSTED' && r.amountCents === 2500) ok('Refund channelStatus=POSTED, amount=2500')
  else bad('refund row mismatch', JSON.stringify(r))
  if (r.channelPostedAt) ok('channelPostedAt populated')
  else bad('channelPostedAt missing', '')
}
{
  const attempts = await dbq(`SELECT outcome FROM "RefundAttempt" WHERE "refundId" IN (SELECT id FROM "Refund" WHERE "returnId" = $1)`, [ret1.id])
  if (attempts.length === 1 && attempts[0].outcome === 'SKIPPED') ok('1 RefundAttempt outcome=SKIPPED')
  else bad('attempts mismatch', JSON.stringify(attempts))
}

console.log('\n[3] Return.refund* cache projected from Refund')
{
  const row = (await dbq(`SELECT status, "refundStatus", "refundCents", "refundedAt", "channelRefundedAt" FROM "Return" WHERE id = $1`, [ret1.id]))[0]
  if (row.status === 'REFUNDED' && row.refundStatus === 'REFUNDED') ok('cache columns: status=REFUNDED, refundStatus=REFUNDED')
  else bad('cache projection wrong', JSON.stringify(row))
  if (row.refundCents === 2500) ok('cache refundCents=2500')
  else bad('cache amount mismatch', row.refundCents)
  if (row.refundedAt && row.channelRefundedAt) ok('cache timestamps populated')
  else bad('cache timestamps missing', JSON.stringify(row))
}

console.log('\n[4] GET /returns/:id/refunds shape')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${ret1.id}/refunds`)
  const j = await r.json()
  if (r.ok && Array.isArray(j.items) && j.items.length === 1) ok('1 refund returned')
  else bad('refund list wrong', JSON.stringify(j))
  const row = j.items[0]
  if (row?.attempts && row.attempts.length === 1) ok('attempts[] inline (1 entry)')
  else bad('attempts inline missing', JSON.stringify(row))
  if (row?.amountCents === 2500 && row?.channelStatus === 'POSTED') ok('amount + channelStatus inline')
  else bad('inline shape wrong', JSON.stringify(row))
}

console.log('\n[5] Multi-refund history — second refund creates a second row')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${ret1.id}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refundCents: 500, skipChannelPush: true, kind: 'STORE_CREDIT' }),
  })
  if (r.ok) ok('second refund accepted')
  else bad('second refund rejected', '')
  const refunds = await dbq(`SELECT "amountCents", kind FROM "Refund" WHERE "returnId" = $1 ORDER BY "createdAt" ASC`, [ret1.id])
  if (refunds.length === 2) ok('2 Refund rows')
  else bad(`expected 2, got ${refunds.length}`, JSON.stringify(refunds))
  if (refunds[1]?.amountCents === 500 && refunds[1]?.kind === 'STORE_CREDIT') ok('second refund: 500 STORE_CREDIT')
  else bad('second refund mismatch', JSON.stringify(refunds))
  // Cache should still reflect latest (500) — most recent createdAt
  const row = (await dbq(`SELECT "refundCents" FROM "Return" WHERE id = $1`, [ret1.id]))[0]
  if (row.refundCents === 500) ok('cache reflects latest refund (500)')
  else bad('cache stale', row.refundCents)
}

console.log('\n[6] perLineAmounts validation — sum mismatch is rejected')
{
  // Need a return with items we can reference
  const items = await dbq(`SELECT id FROM "ReturnItem" WHERE "returnId" = $1 LIMIT 1`, [ret1.id])
  const r = await fetch(`${API}/api/fulfillment/returns/${ret1.id}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refundCents: 1000,
      skipChannelPush: true,
      perLineAmounts: { [items[0].id]: 500 }, // 500 != 1000
    }),
  })
  if (r.status === 400) ok('mismatch sum → 400')
  else bad(`expected 400, got ${r.status}`, await r.text().then(t => t.slice(0, 100)))
}

console.log('\n[7] perLineAmounts: matching sum + valid itemIds → posted with allocation')
{
  const items = await dbq(`SELECT id FROM "ReturnItem" WHERE "returnId" = $1`, [ret1.id])
  const r = await fetch(`${API}/api/fulfillment/returns/${ret1.id}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refundCents: 1500,
      skipChannelPush: true,
      perLineAmounts: { [items[0].id]: 1500 },
    }),
  })
  const j = await r.json()
  if (r.ok && j.refundId) ok('per-line refund posted')
  else bad('per-line refund failed', JSON.stringify(j))
  const refund = (await dbq(`SELECT "perLineAmounts" FROM "Refund" WHERE id = $1`, [j.refundId]))[0]
  if (refund?.perLineAmounts && Object.keys(refund.perLineAmounts)[0] === items[0].id) ok('perLineAmounts JSON persisted')
  else bad('perLineAmounts not stored', JSON.stringify(refund))
}

console.log('\n[8] perLineAmounts: rogue itemId → 400')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${ret1.id}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refundCents: 100,
      skipChannelPush: true,
      perLineAmounts: { 'cm-bogus-item-id': 100 },
    }),
  })
  if (r.status === 400) ok('rogue itemId → 400')
  else bad(`expected 400, got ${r.status}`, '')
}

console.log('\n[9] AuditLog records refund action with refundId metadata')
await new Promise((r) => setTimeout(r, 300))
{
  const audit = await dbq(`SELECT after FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1 AND action = 'refund' ORDER BY "createdAt" DESC LIMIT 1`, [ret1.id])
  if (audit.length === 1) {
    const a = audit[0].after
    if (a?.refundId && a?.channelOutcome === 'SKIPPED') ok(`audit: refundId=${a.refundId}, outcome=${a.channelOutcome}`)
    else bad('audit shape wrong', JSON.stringify(a))
  } else bad('no refund audit', '')
}

console.log('\n[10] missing refundCents → 400')
{
  const create2 = await fetch(`${API}/api/fulfillment/returns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'AMAZON', reason: 'R51_NO_AMOUNT', items: [{ sku: productRow.sku, quantity: 1 }] }),
  })
  const ret2 = await create2.json()
  const r = await fetch(`${API}/api/fulfillment/returns/${ret2.id}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipChannelPush: true }),
  })
  if (r.status === 400) ok('no amount staged + no body amount → 400')
  else bad(`expected 400, got ${r.status}`, '')
  // Cleanup
  await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1`, [ret2.id])
  await dbq(`DELETE FROM "Return" WHERE id = $1`, [ret2.id])
}

// Cleanup primary test
console.log('\n[11] Cleanup')
await dbq(`DELETE FROM "RefundAttempt" WHERE "refundId" IN (SELECT id FROM "Refund" WHERE "returnId" = $1)`, [ret1.id])
await dbq(`DELETE FROM "Refund" WHERE "returnId" = $1`, [ret1.id])
await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1`, [ret1.id])
await dbq(`DELETE FROM "Return" WHERE id = $1`, [ret1.id])
ok('test rows + audits + refunds + attempts deleted')

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
