#!/usr/bin/env node
// H.10 — end-to-end smoke test for the stock surface.
//
// Idempotent: every state change is reversed before exit. Picks a real
// product with stock at IT-MAIN, exercises every mutating endpoint
// (adjust / threshold / reserve / release / transfer), and asserts the
// invariant Product.totalStock = SUM(StockLevel.quantity) at every step.
//
// Run from a shell with API_BASE_URL set (or default to localhost).
//
//   API_BASE_URL=https://nexus-api.up.railway.app node scripts/verify-stock.mjs
//   node scripts/verify-stock.mjs   # uses http://localhost:3001

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const dbUrl = process.env.DATABASE_URL

if (!dbUrl) {
  console.error('DATABASE_URL missing — needed for invariant checks')
  process.exit(1)
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

async function api(method, path, body) {
  // Fastify rejects 'Content-Type: application/json' with empty body —
  // only set the header when we're actually sending JSON.
  const opts = { method }
  if (body != null) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API_BASE}${path}`, opts)
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

const client = new pg.Client({ connectionString: dbUrl })
await client.connect()

async function checkInvariant(label) {
  const r = await client.query(`
    SELECT count(*)::int as drift
    FROM (
      SELECT p.id, p."totalStock", COALESCE(SUM(sl.quantity), 0) as sl_sum
      FROM "Product" p
      LEFT JOIN "StockLevel" sl ON sl."productId" = p.id
      WHERE p."isParent" = false
      GROUP BY p.id, p."totalStock"
      HAVING p."totalStock" != COALESCE(SUM(sl.quantity), 0)
    ) drift
  `)
  if (r.rows[0].drift === 0) ok(`invariant: ${label} (drift=0)`)
  else bad(`invariant: ${label}`, `drift=${r.rows[0].drift}`)
}

console.log(`[verify] API_BASE=${API_BASE}`)
console.log(`[verify] starting`)

// ── 1. Health endpoints respond ────────────────────────────────
for (const path of ['/api/stock/locations', '/api/stock/kpis', '/api/stock/insights', '/api/stock/sync-status']) {
  const r = await api('GET', path)
  if (r.ok) ok(`GET ${path}`)
  else bad(`GET ${path}`, `status=${r.status}`)
}

// ── 2. Pick a target product ───────────────────────────────────
// Find one with totalStock >= 5 at IT-MAIN so we have headroom
// for a +1/-1 adjust + a 1-unit reservation.
const targetRow = await client.query(`
  SELECT sl.id as stock_level_id, sl."productId", sl."locationId", sl.quantity, sl.reserved, sl.available,
         loc.code as location_code,
         p.sku, p.name
  FROM "StockLevel" sl
  JOIN "StockLocation" loc ON loc.id = sl."locationId"
  JOIN "Product" p ON p.id = sl."productId"
  WHERE loc.code = 'IT-MAIN' AND sl.quantity >= 5 AND sl.reserved = 0
  ORDER BY sl.quantity DESC
  LIMIT 1
`)
if (targetRow.rows.length === 0) {
  console.log('[verify] no product with quantity >= 5 at IT-MAIN — skipping mutating tests')
  console.log(`[verify] PASS=${pass} FAIL=${fail}`)
  await client.end()
  process.exit(fail === 0 ? 0 : 1)
}
const target = targetRow.rows[0]
console.log(`[verify] target: ${target.sku} (StockLevel ${target.stock_level_id}, qty=${target.quantity})`)

await checkInvariant('initial')

// ── 3. PATCH /api/stock/:id — adjust + reverse ─────────────────
{
  const r1 = await api('PATCH', `/api/stock/${target.stock_level_id}`, { change: 1, notes: 'verify-stock smoke +1' })
  if (r1.ok) ok('PATCH adjust +1')
  else bad('PATCH adjust +1', `status=${r1.status}`)

  await checkInvariant('after +1')

  const r2 = await api('PATCH', `/api/stock/${target.stock_level_id}`, { change: -1, notes: 'verify-stock smoke -1 (reverse)' })
  if (r2.ok) ok('PATCH adjust -1 (reverse)')
  else bad('PATCH adjust -1', `status=${r2.status}`)

  await checkInvariant('after -1 reverse')
}

// ── 4. PATCH /api/stock/:id — threshold set + clear ────────────
{
  const r1 = await api('PATCH', `/api/stock/${target.stock_level_id}`, { reorderThreshold: 99 })
  if (r1.ok) ok('PATCH threshold 99')
  else bad('PATCH threshold 99', `status=${r1.status}`)

  // Read it back and confirm
  const cur = await client.query('SELECT "reorderThreshold" FROM "StockLevel" WHERE id = $1', [target.stock_level_id])
  if (cur.rows[0]?.reorderThreshold === 99) ok('threshold persisted as 99')
  else bad('threshold persisted', `got ${cur.rows[0]?.reorderThreshold}`)

  const r2 = await api('PATCH', `/api/stock/${target.stock_level_id}`, { reorderThreshold: null })
  if (r2.ok) ok('PATCH threshold null (reset)')
  else bad('PATCH threshold null', `status=${r2.status}`)
}

// ── 5. POST /api/stock/reserve + /release ──────────────────────
{
  const r1 = await api('POST', '/api/stock/reserve', {
    productId: target.productId,
    locationId: target.locationId,
    quantity: 1,
    reason: 'MANUAL_HOLD',
  })
  if (r1.ok && r1.data?.reservation?.id) ok('POST reserve 1 unit')
  else { bad('POST reserve', `status=${r1.status} body=${JSON.stringify(r1.data)}`); }

  if (r1.ok && r1.data?.reservation?.id) {
    // Verify reserved went up + available went down
    const cur = await client.query('SELECT quantity, reserved, available FROM "StockLevel" WHERE id = $1', [target.stock_level_id])
    const row = cur.rows[0]
    if (row.reserved === target.reserved + 1 && row.available === target.quantity - row.reserved) {
      ok('reservation increments reserved + decrements available')
    } else {
      bad('reservation accounting', `expected reserved=${target.reserved + 1}, got reserved=${row.reserved} available=${row.available}`)
    }

    const r2 = await api('POST', `/api/stock/release/${r1.data.reservation.id}`)
    if (r2.ok) ok('POST release')
    else bad('POST release', `status=${r2.status} body=${JSON.stringify(r2.data)}`)

    const after = await client.query('SELECT reserved FROM "StockLevel" WHERE id = $1', [target.stock_level_id])
    if (after.rows[0].reserved === target.reserved) ok('release restores reserved')
    else bad('release accounting', `expected reserved=${target.reserved}, got ${after.rows[0].reserved}`)
  }

  await checkInvariant('after reserve + release cycle')
}

// ── 6. POST /api/stock/transfer (Riccione → FBA, then back) ────
{
  const fbaLoc = await client.query(`SELECT id FROM "StockLocation" WHERE code = 'AMAZON-EU-FBA'`)
  if (fbaLoc.rows.length === 0) {
    bad('transfer setup', 'AMAZON-EU-FBA location missing')
  } else {
    const fbaId = fbaLoc.rows[0].id
    const r1 = await api('POST', '/api/stock/transfer', {
      productId: target.productId,
      fromLocationId: target.locationId,
      toLocationId: fbaId,
      quantity: 1,
      notes: 'verify-stock smoke transfer',
    })
    if (r1.ok) ok('POST transfer 1 unit IT-MAIN → AMAZON-EU-FBA')
    else { bad('POST transfer out', `status=${r1.status} body=${JSON.stringify(r1.data)}`); }

    await checkInvariant('after transfer out')

    if (r1.ok) {
      const r2 = await api('POST', '/api/stock/transfer', {
        productId: target.productId,
        fromLocationId: fbaId,
        toLocationId: target.locationId,
        quantity: 1,
        notes: 'verify-stock smoke transfer reverse',
      })
      if (r2.ok) ok('POST transfer reverse 1 unit AMAZON-EU-FBA → IT-MAIN')
      else bad('POST transfer reverse', `status=${r2.status} body=${JSON.stringify(r2.data)}`)

      await checkInvariant('after transfer reverse')
    }
  }
}

// ── 7. Audit trail completeness — every test write left a row ──
const recentMovementsForProduct = await client.query(`
  SELECT count(*)::int as n FROM "StockMovement"
  WHERE "productId" = $1 AND "createdAt" >= now() - interval '5 minutes'
`, [target.productId])
if (recentMovementsForProduct.rows[0].n >= 4) {
  ok(`audit trail has ${recentMovementsForProduct.rows[0].n} recent movements (≥4 expected)`)
} else {
  bad('audit trail completeness', `only ${recentMovementsForProduct.rows[0].n} movements found`)
}

await client.end()

console.log(`\n[verify] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
}
process.exit(fail === 0 ? 0 : 1)
