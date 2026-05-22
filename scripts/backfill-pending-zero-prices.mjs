#!/usr/bin/env node
/**
 * GS-RT.5 — one-time backfill driver for Amazon orders ingested at €0.
 *
 * Background
 * ----------
 * SP-API ListOrders withholds OrderTotal for PENDING orders. SA.2
 * added an eager getOrder at upsert time, but it can still fail
 * silently (rate limit, transient error, Amazon still withholding).
 * When the order later leaves PENDING, the SQS ORDER_CHANGE → SP-API
 * ListOrders path re-enters and may STILL see €0 if Amazon's
 * ListOrders response is fragmented. Result: a long-lived population
 * of `totalPrice=0` Order rows that the Global Snapshot under-reports.
 *
 * What this does
 * --------------
 * Walks `WHERE channel='AMAZON' AND totalPrice=0 AND status NOT IN
 * (PENDING, CANCELLED)` in pages of `--limit` (default 100). For each
 * row, calls `getOrder` directly — which returns OrderTotal for ALL
 * statuses, including PENDING. Updates `totalPrice` + `currencyCode`
 * if a positive amount comes back; skips otherwise. Logs counts +
 * first N errors.
 *
 * Idempotent: re-running picks up new €0 rows and skips ones that
 * still don't have an OrderTotal in Amazon's response.
 *
 * Usage
 * -----
 *   node scripts/backfill-pending-zero-prices.mjs \
 *     --api-url https://api.nexus-commerce.up.railway.app \
 *     [--limit 100] \
 *     [--include-pending]
 *
 * Local dev (if API is running on :4001):
 *   node scripts/backfill-pending-zero-prices.mjs \
 *     --api-url http://localhost:4001 --include-pending
 *
 * Exit codes:
 *   0 — script ran (regardless of how many rows repaired)
 *   1 — invocation error / API failure / network failure
 */

const args = process.argv.slice(2)
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return fallback
  const next = args[idx + 1]
  if (next == null || next.startsWith('--')) return true
  return next
}

const apiUrl = getArg('api-url', process.env.NEXUS_API_URL || 'http://localhost:4001')
const limit = Number(getArg('limit', 100))
const includePending = getArg('include-pending', false) === true || getArg('include-pending', false) === 'true'

if (!apiUrl) {
  console.error('[backfill] FAIL — --api-url required (or NEXUS_API_URL env)')
  process.exit(1)
}
if (!Number.isFinite(limit) || limit <= 0) {
  console.error(`[backfill] FAIL — --limit must be a positive number, got "${limit}"`)
  process.exit(1)
}

console.log(`[backfill] target: ${apiUrl}`)
console.log(`[backfill] limit:  ${limit}`)
console.log(`[backfill] includePending: ${includePending}`)
console.log('')

const endpoint = `${apiUrl.replace(/\/$/, '')}/api/amazon/orders/backfill-zero-totals`

let res
try {
  res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit, includePending }),
  })
} catch (err) {
  console.error(`[backfill] FAIL — network error: ${err?.message ?? err}`)
  process.exit(1)
}

let body
try {
  body = await res.json()
} catch (err) {
  console.error(`[backfill] FAIL — could not parse response JSON (HTTP ${res.status})`)
  process.exit(1)
}

if (!res.ok || body?.success === false) {
  console.error(`[backfill] FAIL — endpoint returned HTTP ${res.status}: ${body?.error ?? '(no error message)'}`)
  process.exit(1)
}

console.log('[backfill] === RESULT ===')
console.log(`[backfill] scanned:  ${body.scanned ?? 0}`)
console.log(`[backfill] repaired: ${body.repaired ?? 0}  ← prices now in DB`)
console.log(`[backfill] skipped:  ${body.skipped ?? 0}  ← Amazon also has no OrderTotal`)
console.log(`[backfill] failed:   ${body.failed ?? 0}`)

if (Array.isArray(body.skips) && body.skips.length > 0) {
  console.log('')
  console.log('[backfill] === SKIPS (first 10) ===')
  for (const s of body.skips.slice(0, 10)) {
    const status = s.status ? ` [status:${s.status}]` : ''
    console.log(`[backfill]   ${s.orderId}${status} — ${s.reason}`)
  }
  if (body.skips.length > 10) {
    console.log(`[backfill]   …and ${body.skips.length - 10} more`)
  }
}

if (Array.isArray(body.errors) && body.errors.length > 0) {
  console.log('')
  console.log('[backfill] === ERRORS (first 10) ===')
  for (const e of body.errors.slice(0, 10)) {
    console.log(`[backfill]   ${e.orderId} — ${e.error}`)
  }
  if (body.errors.length > 10) {
    console.log(`[backfill]   …and ${body.errors.length - 10} more`)
  }
}

console.log('')
if (body.scanned >= limit) {
  console.log(`[backfill] HINT: scanned == limit (${limit}). Re-run to process the next page.`)
}
console.log('[backfill] done')
process.exit(0)
