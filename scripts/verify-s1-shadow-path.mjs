#!/usr/bin/env node
/**
 * S.1 verification — proves the shadow inventory-sync path is gone and
 * webhook + mock-order paths now route through canonical applyStockMovement.
 *
 * Read-only against the DB; mutates only via the public API (and reverses
 * every change). Run from a shell with API_BASE_URL set:
 *
 *   API_BASE_URL=https://nexus-api.up.railway.app node scripts/verify-s1-shadow-path.mjs
 *   node scripts/verify-s1-shadow-path.mjs   # uses http://localhost:3001
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing — needed for invariant checks')
  process.exit(1)
}

// S.30 — quick reachability probe. The script is an integration test
// that mutates+reverses through the public API; if the API isn't up
// (common locally outside of `npm run dev`), exit 0 with a skip
// notice so the master harness reports SKIPPED rather than failed.
async function probeApi() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}
if (!(await probeApi())) {
  console.log(`[S.1 verify] SKIPPED — API at ${API_BASE} not reachable. Boot the API (npm run dev) or set API_BASE_URL=https://nexus-api.up.railway.app to run this gate.`)
  process.exit(0)
}

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
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

async function totalStockDrift(label) {
  const r = await client.query(`
    SELECT count(*)::int AS drift
    FROM "Product" p
    LEFT JOIN (
      SELECT "productId", SUM(quantity) AS sq FROM "StockLevel" GROUP BY "productId"
    ) sl ON sl."productId" = p.id
    WHERE p."isParent" = false
      AND p."totalStock" != COALESCE(sl.sq, 0)
  `)
  if (r.rows[0].drift === 0) ok(`${label}: no totalStock drift`)
  else bad(`${label}: totalStock drift`, `count=${r.rows[0].drift}`)
}

console.log(`[S.1 verify] API_BASE=${API_BASE}`)
console.log(`[S.1 verify] starting`)

// ── 1. Shadow service file is gone ──────────────────────────────
import('node:fs').then((fs) => {
  const shadowPath = path.join(here, '..', 'apps/api/src/services/inventory-sync.service.ts')
  if (fs.existsSync(shadowPath)) bad('shadow service file removed', `still exists at ${shadowPath}`)
  else ok('shadow service file removed (apps/api/src/services/inventory-sync.service.ts)')
})

// ── 2. Twin syncGlobalStock removed from services/inventory.ts ──
import('node:fs').then(async (fs) => {
  const p = path.join(here, '..', 'apps/api/src/services/inventory.ts')
  const src = fs.readFileSync(p, 'utf8')
  if (src.includes('export async function syncGlobalStock(')) {
    bad('twin syncGlobalStock removed from inventory.ts')
  } else {
    ok('twin syncGlobalStock removed from inventory.ts')
  }
  // Other utilities should still be present
  for (const fn of ['deductStock', 'addStock', 'getStockHistory', 'getChannelSyncStatus']) {
    if (src.includes(`export async function ${fn}`)) ok(`inventory.ts still exports ${fn}`)
    else bad(`inventory.ts still exports ${fn}`, 'unexpectedly removed')
  }
})

// ── 3. recent-adjustments endpoint is gone ──────────────────────
{
  const r = await api('GET', '/webhooks/recent-adjustments?limit=5')
  if (r.status === 404) ok('GET /webhooks/recent-adjustments returns 404 (removed)')
  else bad('GET /webhooks/recent-adjustments returns 404', `got status=${r.status}`)
}

// ── 4. order-created webhook routes through canonical ───────────
const targetRow = await client.query(`
  SELECT sl.id AS stock_level_id, sl."productId", sl.quantity, p.sku
  FROM "StockLevel" sl
  JOIN "StockLocation" loc ON loc.id = sl."locationId"
  JOIN "Product" p ON p.id = sl."productId"
  WHERE loc.code = 'IT-MAIN' AND sl.quantity >= 5 AND sl.reserved = 0
  ORDER BY sl.quantity DESC
  LIMIT 1
`)
if (targetRow.rows.length === 0) {
  console.log('[S.1 verify] no product with quantity >= 5 at IT-MAIN — skipping mutating tests')
} else {
  const t = targetRow.rows[0]
  const startQty = t.quantity
  const sku = t.sku

  await totalStockDrift('pre-test')

  // Decrement 1 via order-created webhook
  const decResp = await api('POST', '/api/webhooks/order-created', {
    sku, quantity: 1, channel: 'TEST_S1', orderId: `S1-VERIFY-${Date.now()}`,
  })
  if (decResp.ok && decResp.data?.success && decResp.data?.data?.movement?.id) {
    ok('POST /api/webhooks/order-created returns success with movement id')
    const m = decResp.data.data.movement
    if (m.locationId) ok('movement has locationId set')
    else bad('movement has locationId set', 'missing')
    if (m.quantityBefore != null) ok('movement has quantityBefore set')
    else bad('movement has quantityBefore set', 'missing')
    if (m.balanceAfter === startQty - 1) ok('balanceAfter = startQty - 1')
    else bad('balanceAfter = startQty - 1', `got ${m.balanceAfter} expected ${startQty - 1}`)
    if (m.reason === 'ORDER_PLACED') ok('reason = ORDER_PLACED')
    else bad('reason = ORDER_PLACED', `got ${m.reason}`)
  } else {
    bad('POST /api/webhooks/order-created success', `status=${decResp.status} body=${JSON.stringify(decResp.data)}`)
  }

  // Verify DB rows are well-formed
  const dbCheck = await client.query(
    `SELECT "locationId", "quantityBefore", "balanceAfter", reason::text, actor, "referenceType"
     FROM "StockMovement" WHERE actor = 'webhook:order-created'
     ORDER BY "createdAt" DESC LIMIT 1`
  )
  if (dbCheck.rows.length > 0) {
    const m = dbCheck.rows[0]
    if (m.locationId) ok('DB: webhook movement has locationId')
    else bad('DB: webhook movement has locationId', `null`)
    if (m.quantityBefore != null) ok('DB: webhook movement has quantityBefore')
    else bad('DB: webhook movement has quantityBefore', 'null')
    if (m.referenceType === 'Webhook') ok('DB: referenceType = Webhook')
    else bad('DB: referenceType = Webhook', `got ${m.referenceType}`)
  } else {
    bad('DB: webhook movement found', 'no rows with actor=webhook:order-created')
  }

  await totalStockDrift('after order-created webhook')

  // Reverse via stock-adjustment webhook (set back to startQty)
  const adjResp = await api('POST', '/webhooks/stock-adjustment', {
    sku, newQuantity: startQty, reason: 'ADJUSTMENT',
  })
  if (adjResp.ok && adjResp.data?.success) {
    ok('POST /webhooks/stock-adjustment returns success')
    const m = adjResp.data.data?.movement
    if (m && m.locationId) ok('adjustment movement has locationId')
    else if (!m) bad('adjustment movement returned', 'movement missing in response')
    else bad('adjustment movement has locationId', 'missing')
  } else {
    bad('POST /webhooks/stock-adjustment success', `status=${adjResp.status}`)
  }

  await totalStockDrift('after stock-adjustment webhook (reversal)')

  // Verify the post-reversal state matches the original
  const finalRow = await client.query(
    `SELECT quantity FROM "StockLevel" WHERE id = $1`, [t.stock_level_id]
  )
  if (finalRow.rows[0]?.quantity === startQty) ok(`final quantity restored to ${startQty}`)
  else bad(`final quantity restored to ${startQty}`, `got ${finalRow.rows[0]?.quantity}`)
}

// ── 5. No new shadow-path movements created ─────────────────────
{
  const r = await client.query(`
    SELECT count(*)::int AS n FROM "StockMovement"
    WHERE "referenceType" = 'inventory-sync.service'
      AND "createdAt" > now() - interval '1 hour'
  `)
  if (r.rows[0].n === 0) ok('no NEW shadow-path movements in last hour')
  else bad('no NEW shadow-path movements in last hour', `count=${r.rows[0].n}`)
}

// ── 6. CHECK: available = quantity - reserved holds ─────────────
{
  const r = await client.query(`
    SELECT count(*)::int AS n FROM "StockLevel" WHERE available != (quantity - reserved)
  `)
  if (r.rows[0].n === 0) ok('available = quantity - reserved invariant holds')
  else bad('available = quantity - reserved invariant', `${r.rows[0].n} broken rows`)
}

// ── 7. invalid-payload guards ───────────────────────────────────
{
  const r = await api('POST', '/api/webhooks/order-created', { sku: 'NOPE-DOES-NOT-EXIST', quantity: 1 })
  if (r.status === 404) ok('order-created returns 404 for unknown SKU')
  else bad('order-created returns 404 for unknown SKU', `got ${r.status}`)
}
{
  const r = await api('POST', '/api/webhooks/order-created', { sku: 'X', quantity: 0 })
  if (r.status === 400) ok('order-created returns 400 for quantity <= 0')
  else bad('order-created returns 400 for quantity <= 0', `got ${r.status}`)
}
{
  const r = await api('POST', '/webhooks/stock-adjustment', { sku: 'X', newQuantity: -1 })
  if (r.status === 400) ok('stock-adjustment returns 400 for newQuantity < 0')
  else bad('stock-adjustment returns 400 for newQuantity < 0', `got ${r.status}`)
}

await client.end()

console.log()
console.log(`[S.1 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  console.log('failures:')
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
