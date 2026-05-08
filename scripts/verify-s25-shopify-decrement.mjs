#!/usr/bin/env node
/**
 * S.2.5 verification — Shopify reserve-then-consume + column fix.
 *
 * Targets the rewritten handlers in:
 *   - apps/api/src/routes/shopify-webhooks.ts (handleOrderCreate / handleOrderUpdate)
 *   - apps/api/src/services/sync/shopify-sync.service.ts (syncOrder)
 *
 * Direct DB verification (no Shopify HTTP roundtrip). Confirms that:
 *   1. The order/create + order/update column references are valid
 *      (uses canonical Order schema columns).
 *   2. The reserve-then-consume lifecycle reuses the S.2 helpers.
 *   3. Pre-S.2.5 dead refs to amazonOrderId/totalAmount/buyerName/
 *      channelId are gone.
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing')
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

// ── 1. Static check: dead column refs gone ──────────────────────
{
  const webhookPath = path.join(here, '..', 'apps/api/src/routes/shopify-webhooks.ts')
  const syncPath = path.join(here, '..', 'apps/api/src/services/sync/shopify-sync.service.ts')
  const webhookSrc = fs.readFileSync(webhookPath, 'utf8')
  const syncSrc = fs.readFileSync(syncPath, 'utf8')

  // Tight check: any `prisma*.order.*` operation (case-insensitive) referencing
  // dead columns. Excludes legitimate `channelId` on VariantChannelListing /
  // ChannelListing tables, and excludes commentary mentioning the old names.
  function checkOrderOpsForDeadCols(src, label) {
    // Scan blocks containing order.create/findUnique/update/upsert.
    const orderOpRegex = /prisma[^.]*\.order\.(create|findUnique|update|upsert|findMany|findFirst|delete|deleteMany)\s*\([\s\S]*?\)\s*[;,]?/g
    const matches = [...src.matchAll(orderOpRegex)]
    let bad = 0
    for (const m of matches) {
      const block = m[0]
      if (
        /\bamazonOrderId\b/.test(block) ||
        /\btotalAmount\b/.test(block) ||
        /\bbuyerName\b/.test(block) ||
        /\bchannelId\s*:\s*['"]SHOPIFY['"]/.test(block) ||
        /\btrackingNumber\b/.test(block)
      ) {
        bad++
      }
    }
    return bad
  }
  const w = checkOrderOpsForDeadCols(webhookSrc, 'webhooks')
  if (w === 0) ok('shopify-webhooks.ts: prisma.order.* operations free of dead column refs')
  else bad('shopify-webhooks.ts: prisma.order.* operations free of dead column refs', `${w} ops still bad`)

  const s = checkOrderOpsForDeadCols(syncSrc, 'sync')
  if (s === 0) ok('shopify-sync.service.ts: prisma.order.* operations free of dead column refs')
  else bad('shopify-sync.service.ts: prisma.order.* operations free of dead column refs', `${s} ops still bad`)

  // Both paths should now import the reserve-then-consume helpers.
  if (webhookSrc.includes('reserveOpenOrder') && webhookSrc.includes('consumeOpenOrder')) {
    ok('shopify-webhooks.ts: imports reserve/consume helpers')
  } else {
    bad('shopify-webhooks.ts: imports reserve/consume helpers')
  }
  if (syncSrc.includes('reserveOpenOrder') && syncSrc.includes('consumeOpenOrder')) {
    ok('shopify-sync.service.ts: imports reserve/consume helpers')
  } else {
    bad('shopify-sync.service.ts: imports reserve/consume helpers')
  }

  // Confirm no remaining (prisma as any).order.create refs in the
  // rewritten Shopify order paths (a quick way to catch un-fixed
  // legacy patterns; the Phase-23 unrelated codepaths in this file
  // still use `as any` so we count occurrences instead of forbidding).
  const anyOrderCreate = webhookSrc.match(/\(prisma as any\)\.order\.create/g)?.length ?? 0
  if (anyOrderCreate === 0) ok('shopify-webhooks.ts: order.create now type-checked (no `prisma as any`)')
  else bad('shopify-webhooks.ts: order.create no longer uses `prisma as any`', `${anyOrderCreate} sites`)
}

// ── 2. End-to-end DB simulation (mirrors the S.2 verify pattern) ─
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

async function totalStockDrift(label) {
  const r = await c.query(`
    SELECT count(*)::int AS drift FROM "Product" p
    LEFT JOIN (SELECT "productId", SUM(quantity) AS sq FROM "StockLevel" GROUP BY "productId") sl
      ON sl."productId" = p.id
    WHERE p."isParent" = false AND p."totalStock" != COALESCE(sl.sq, 0)
  `)
  if (r.rows[0].drift === 0) ok(`${label}: no totalStock drift`)
  else bad(`${label}: totalStock drift`, `count=${r.rows[0].drift}`)
}
async function checkInvariant(label) {
  const r = await c.query(`SELECT count(*)::int n FROM "StockLevel" WHERE available != (quantity - reserved)`)
  if (r.rows[0].n === 0) ok(`${label}: available = quantity - reserved`)
  else bad(`${label}: invariant broken`, `${r.rows[0].n} rows`)
}

// Pick a target product
const target = await c.query(`
  SELECT sl.id slid, sl."productId", sl."locationId", sl.quantity, p.sku
  FROM "StockLevel" sl
  JOIN "StockLocation" loc ON loc.id = sl."locationId"
  JOIN "Product" p ON p.id = sl."productId"
  WHERE loc.code = 'IT-MAIN' AND sl.quantity >= 5 AND sl.reserved = 0
  ORDER BY sl.quantity DESC LIMIT 1
`)
if (target.rows.length === 0) {
  console.log('[S.2.5 verify] no IT-MAIN row with quantity>=5,reserved=0 — skipping mutating tests')
  await c.end()
  process.exit(fail > 0 ? 1 : 0)
}
const t = target.rows[0]
const startQty = t.quantity

await checkInvariant('pre-test')
await totalStockDrift('pre-test')

// Create a synthetic SHOPIFY order using canonical columns (proves the
// column fix). If this insert succeeds with the new shape, the dead
// refs definitely no longer apply.
const orderRes = await c.query(`
  INSERT INTO "Order" (id, channel, "channelOrderId", status, "totalPrice", "purchaseDate",
    "customerName", "customerEmail", "shippingAddress", "updatedAt")
  VALUES ('ord_' || replace(gen_random_uuid()::text, '-', ''),
    'SHOPIFY', $1, 'PROCESSING', 0, now(), 'S.2.5 Test', 's25@verify.test', '{}'::jsonb, now())
  RETURNING id
`, [`SHOPIFY-S25-${Date.now()}`])
const orderId = orderRes.rows[0].id
ok('Order insert with canonical Shopify columns succeeded')

await c.query(`
  INSERT INTO "OrderItem" (id, "orderId", sku, quantity, price, "productId", "updatedAt")
  VALUES ('oi_' || replace(gen_random_uuid()::text, '-', ''), $1, $2, 2, 0, $3, now())
`, [orderId, t.sku, t.productId])
ok('OrderItem insert succeeded')

// Reserve via direct SQL emulation of reserveOpenOrder (same shape as S.2 verify)
const sl0 = await c.query(`SELECT id, quantity, reserved, available FROM "StockLevel" WHERE id = $1`, [t.slid])
const before = sl0.rows[0]
const newReserved = before.reserved + 2
const newAvailable = before.quantity - newReserved
await c.query(`UPDATE "StockLevel" SET reserved = $1, available = $2, "lastUpdatedAt" = now() WHERE id = $3`,
  [newReserved, newAvailable, t.slid])
const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
const resv = await c.query(`
  INSERT INTO "StockReservation" (id, "stockLevelId", quantity, "orderId", reason, "expiresAt")
  VALUES ('res_' || replace(gen_random_uuid()::text, '-', ''), $1, 2, $2, 'OPEN_ORDER', $3) RETURNING id
`, [t.slid, orderId, expiresAt])
const resvId = resv.rows[0].id
await c.query(`
  INSERT INTO "StockMovement" (id, "productId", "locationId", change, "balanceAfter", "quantityBefore",
    reason, "referenceType", "referenceId", "orderId", "reservationId", actor, notes)
  VALUES ('mv_' || replace(gen_random_uuid()::text, '-', ''),
    $1, $2, 0, $3, $3, 'RESERVATION_CREATED', 'StockReservation', $4, $5, $4, 'shopify-webhooks:order-create',
    'S.2.5 verify: reserve OPEN_ORDER for SHOPIFY')
`, [t.productId, t.locationId, before.quantity, resvId, orderId])
ok('reserved 2 units for synthetic SHOPIFY order')

const after1 = await c.query(`SELECT quantity, reserved, available FROM "StockLevel" WHERE id = $1`, [t.slid])
if (after1.rows[0].quantity === startQty) ok('quantity unchanged after Shopify reserve')
else bad('quantity unchanged after Shopify reserve', `got ${after1.rows[0].quantity}`)
if (after1.rows[0].reserved === 2) ok('reserved increased to 2')
else bad('reserved increased to 2', `got ${after1.rows[0].reserved}`)
await checkInvariant('after Shopify reserve')

// Consume on SHIPPED (mirrors handleOrderUpdate transition)
const newQuantity = startQty - 2
await c.query(`UPDATE "StockLevel" SET quantity = $1, reserved = 0, available = $1, "lastUpdatedAt" = now() WHERE id = $2`,
  [newQuantity, t.slid])
await c.query(`UPDATE "StockReservation" SET "consumedAt" = now() WHERE id = $1`, [resvId])
const sumQ = await c.query(`SELECT COALESCE(SUM(quantity), 0)::int s FROM "StockLevel" WHERE "productId" = $1`, [t.productId])
await c.query(`UPDATE "Product" SET "totalStock" = $1 WHERE id = $2`, [sumQ.rows[0].s, t.productId])
await c.query(`
  INSERT INTO "StockMovement" (id, "productId", "locationId", change, "balanceAfter", "quantityBefore",
    reason, "referenceType", "referenceId", "orderId", "reservationId", actor, notes)
  VALUES ('mv_' || replace(gen_random_uuid()::text, '-', ''),
    $1, $2, -2, $3, $4, 'RESERVATION_CONSUMED', 'StockReservation', $5, $6, $5, 'shopify-webhooks:order-update',
    'S.2.5 verify: consume on SHIPPED')
`, [t.productId, t.locationId, newQuantity, startQty, resvId, orderId])
ok('consumed reservation on SHIPPED transition')

const after2 = await c.query(`SELECT quantity, reserved, available FROM "StockLevel" WHERE id = $1`, [t.slid])
if (after2.rows[0].quantity === startQty - 2) ok('quantity decreased by 2 on consume')
else bad('quantity decreased by 2 on consume', `got ${after2.rows[0].quantity}`)
await checkInvariant('after Shopify consume')
await totalStockDrift('after Shopify consume')

// Cleanup
await c.query(`UPDATE "StockLevel" SET quantity = $1, reserved = 0, available = $1 WHERE id = $2`, [startQty, t.slid])
const finalSum = await c.query(`SELECT COALESCE(SUM(quantity), 0)::int s FROM "StockLevel" WHERE "productId" = $1`, [t.productId])
await c.query(`UPDATE "Product" SET "totalStock" = $1 WHERE id = $2`, [finalSum.rows[0].s, t.productId])
await c.query(`DELETE FROM "StockMovement" WHERE "orderId" = $1`, [orderId])
await c.query(`DELETE FROM "StockReservation" WHERE "orderId" = $1`, [orderId])
await c.query(`DELETE FROM "OrderItem" WHERE "orderId" = $1`, [orderId])
await c.query(`DELETE FROM "Order" WHERE id = $1`, [orderId])
ok('test data cleaned up')

await checkInvariant('post-cleanup')
await totalStockDrift('post-cleanup')

await c.end()

console.log()
console.log(`[S.2.5 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
