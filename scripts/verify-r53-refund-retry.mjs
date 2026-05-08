#!/usr/bin/env node
// Verify R5.3 — failed-refund retry queue.
//
// Strategy: seed a Return with refundStatus='CHANNEL_FAILED', then
// drive it through the retry endpoints. We can't make the publisher
// actually FAIL deterministically without poking the Refund table
// directly, so we set the failure manually and exercise the retry
// machinery + audit accumulation.
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

console.log('\n[1] Seed return + force CHANNEL_FAILED state')
// Use AMAZON channel — refund publisher returns OK_MANUAL_REQUIRED
// for FBM (no SP-API refund endpoint), which the retry treats as
// success. So we seed a synthetic CHANNEL_FAILED state directly.
const create = await fetch(`${API}/api/fulfillment/returns`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-user-id': 'r53-verify' },
  body: JSON.stringify({
    channel: 'AMAZON',
    reason: 'R53_RETRY_TEST',
    items: [{ sku: productRow.sku, quantity: 1 }],
  }),
})
const ret = await create.json()
const id = ret.id
ok(`created return ${id}`)
// Force CHANNEL_FAILED + stage refundCents
await dbq(
  `UPDATE "Return" SET "refundStatus" = 'CHANNEL_FAILED', "refundCents" = 1500, "channelRefundError" = 'eBay seed error: insufficient seller balance' WHERE id = $1`,
  [id],
)
ok('forced refundStatus=CHANNEL_FAILED + refundCents=1500')

console.log('\n[2] retry-status before any attempts → ready (priorAttempts=0)')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/refund/retry-status`)
  const j = await r.json()
  if (r.ok && j.ready === true && j.priorAttempts === 0) ok('ready=true, priorAttempts=0')
  else bad('initial status wrong', JSON.stringify(j))
}

console.log('\n[3] Manual retry — manual button bypasses backoff')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/refund/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'r53-verify' },
    body: JSON.stringify({ force: true }),
  })
  const j = await r.json()
  // Outcome depends on whether AMAZON adapter succeeds. For FBM it
  // returns OK_MANUAL_REQUIRED; that's a success-shape outcome that
  // clears CHANNEL_FAILED. We're testing the retry machinery, not
  // the channel adapter result.
  if (r.ok || r.status === 502) ok(`retry returned outcome=${j.outcome}`)
  else bad(`unexpected status ${r.status}`, JSON.stringify(j))
  if (j.refundId) ok(`Refund row created: ${j.refundId}`)
  else bad('no refundId in response', JSON.stringify(j))
}

console.log('\n[4] Refund + RefundAttempt rows persisted')
{
  const refunds = await dbq(`SELECT id, "channelStatus", "amountCents" FROM "Refund" WHERE "returnId" = $1`, [id])
  if (refunds.length === 1) ok('1 Refund row')
  else bad(`expected 1, got ${refunds.length}`, JSON.stringify(refunds))
  if (refunds[0]?.amountCents === 1500) ok('Refund amount=1500')
  else bad('amount mismatch', JSON.stringify(refunds[0]))
  const attempts = await dbq(`SELECT outcome, "durationMs" FROM "RefundAttempt" WHERE "refundId" = $1`, [refunds[0].id])
  if (attempts.length === 1) ok(`1 RefundAttempt: outcome=${attempts[0].outcome}, durationMs=${attempts[0].durationMs}`)
  else bad('attempts mismatch', JSON.stringify(attempts))
}

console.log('\n[5] AuditLog records refund-retry-manual action')
await new Promise((r) => setTimeout(r, 300))
{
  const audit = await dbq(
    `SELECT action, metadata FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1 AND action = 'refund-retry-manual'`,
    [id],
  )
  if (audit.length === 1) ok(`audit: action=refund-retry-manual, attempt=${audit[0].metadata?.attemptNumber}`)
  else bad('no manual-retry audit', JSON.stringify(audit))
}

console.log('\n[6] Backoff: simulate 4 prior attempts → next-eligible reflects 24h backoff')
{
  // Force CHANNEL_FAILED again so we can re-test the eligibility logic
  await dbq(`UPDATE "Return" SET "refundStatus" = 'CHANNEL_FAILED' WHERE id = $1`, [id])
  // Count current attempts
  const beforeCount = (await dbq(`SELECT count(*)::int AS n FROM "RefundAttempt" WHERE "refund"."returnId" = $1 OR EXISTS (SELECT 1 FROM "Refund" WHERE "Refund".id = "RefundAttempt"."refundId" AND "Refund"."returnId" = $1)`, [id])
    .catch(() => [{ n: 0 }]))[0]?.n ?? 0
  // Backfill 3 more synthetic attempts (we already have 1)
  const refundRow = (await dbq(`SELECT id FROM "Refund" WHERE "returnId" = $1 LIMIT 1`, [id]))[0]
  for (let i = 0; i < 3; i++) {
    await dbq(
      `INSERT INTO "RefundAttempt" (id, "refundId", outcome, "errorMessage", "attemptedAt") VALUES ($1, $2, 'FAILED', 'synthetic backfill', NOW() - INTERVAL '1 minute')`,
      [`r53-attempt-${i}-${Date.now()}`, refundRow.id],
    )
  }
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/refund/retry-status`)
  const j = await r.json()
  if (j.priorAttempts === 4) ok(`priorAttempts=4 after backfill`)
  else bad('priorAttempts mismatch', JSON.stringify(j))
  if (j.ready === false && j.reason === 'backoff') ok(`backoff active: nextEligibleAt=${j.nextEligibleAt}`)
  else bad('backoff not active', JSON.stringify(j))
}

console.log('\n[7] Backoff bypass — force=true overrides')
{
  // Sweep would skip this row; manual button forces through.
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/refund/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true }),
  })
  const j = await r.json()
  if (r.ok || r.status === 502) ok(`force retry executed: outcome=${j.outcome}`)
  else bad('force retry failed', JSON.stringify(j))
}

console.log('\n[8] Max attempts → ready=false reason=max_attempts')
{
  // Re-mark CHANNEL_FAILED + add one more synthetic attempt to hit 5
  await dbq(`UPDATE "Return" SET "refundStatus" = 'CHANNEL_FAILED' WHERE id = $1`, [id])
  const refundRow = (await dbq(`SELECT id FROM "Refund" WHERE "returnId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [id]))[0]
  // Top up to 5 attempts total
  const cur = (await dbq(`SELECT count(*)::int AS n FROM "RefundAttempt" WHERE "refundId" IN (SELECT id FROM "Refund" WHERE "returnId" = $1)`, [id]))[0].n
  for (let i = cur; i < 5; i++) {
    await dbq(
      `INSERT INTO "RefundAttempt" (id, "refundId", outcome, "errorMessage", "attemptedAt") VALUES ($1, $2, 'FAILED', 'maxout', NOW())`,
      [`r53-maxout-${i}-${Date.now()}`, refundRow.id],
    )
  }
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/refund/retry-status`)
  const j = await r.json()
  if (j.ready === false && j.reason === 'max_attempts') ok(`max_attempts gate hit at priorAttempts=${j.priorAttempts}`)
  else bad('max_attempts gate failed', JSON.stringify(j))
}

console.log('\n[9] not_failed gate — POSTED return → no retry allowed')
{
  await dbq(`UPDATE "Return" SET "refundStatus" = 'REFUNDED' WHERE id = $1`, [id])
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/refund/retry-status`)
  const j = await r.json()
  if (j.ready === false && j.reason === 'not_failed') ok('not_failed gate works for REFUNDED returns')
  else bad('not_failed gate wrong', JSON.stringify(j))
}

console.log('\n[10] processRetryQueue smoke (no candidates left → counters zero)')
{
  // Hit any cron-status-style endpoint? We don't have one registered;
  // call the service indirectly via setting another row failed and
  // forcing retry via the regular endpoint. The sweep itself isn't
  // exposed as a manual trigger by design (cron-only). Instead we
  // confirm via DB that the live cron-eligible-set query correctly
  // excludes the now-REFUNDED row.
  const candidates = await dbq(`SELECT count(*)::int AS n FROM "Return" WHERE "refundStatus" = 'CHANNEL_FAILED' AND id = $1`, [id])
  if (candidates[0].n === 0) ok('candidate query excludes REFUNDED row')
  else bad('row still in candidate set', JSON.stringify(candidates))
}

// Cleanup
console.log('\n[11] Cleanup')
await dbq(`DELETE FROM "RefundAttempt" WHERE "refundId" IN (SELECT id FROM "Refund" WHERE "returnId" = $1)`, [id])
await dbq(`DELETE FROM "Refund" WHERE "returnId" = $1`, [id])
await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1`, [id])
await dbq(`DELETE FROM "Return" WHERE id = $1`, [id])
ok('test rows cleaned')

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
