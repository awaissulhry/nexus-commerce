#!/usr/bin/env node
/**
 * Stock health check — Wave 1 closing artifact.
 *
 * Runs the invariants Wave 1 (S.1, S.2, S.2.5) was meant to enforce.
 * Pure database (no API process required) so it can be run as:
 *   - a nightly cron / CI gate
 *   - a pre-deploy smoke gate against staging or production
 *   - a post-incident triage pass
 *
 * Exit code is 0 on green, 1 on any failure. Designed to be parsed by
 * monitoring (e.g. cron output piped to alerting) — every line either
 * starts with ✓ (pass) or ✗ (fail), with a counter at the end.
 *
 * Run:
 *   node scripts/health-stock-invariants.mjs
 *
 * Useful filters: `node scripts/health-stock-invariants.mjs --json` returns
 * a single JSON object instead of human output.
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const JSON_MODE = process.argv.includes('--json')

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing')
  process.exit(2)
}

const checks = []
function record(name, pass, detail) {
  checks.push({ name, pass, detail: detail ?? null })
  if (!JSON_MODE) console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// ── Wave 1 / H.1 invariants ─────────────────────────────────────

// 1. CHECK constraint: available = quantity - reserved
{
  const r = await c.query(`
    SELECT count(*)::int n, COALESCE(json_agg(id) FILTER (WHERE available != (quantity - reserved)), '[]') sample
    FROM "StockLevel" WHERE available != (quantity - reserved)
  `)
  record('available = quantity - reserved (StockLevel CHECK)', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} broken rows` : null)
}

// 2. Product.totalStock = SUM(StockLevel.quantity) — H.1 cache invariant
{
  const r = await c.query(`
    SELECT count(*)::int n,
      json_agg(p.sku ORDER BY p.sku) FILTER (WHERE drift > 0) AS drifted_skus
    FROM (
      SELECT p.id, p.sku, p."totalStock" - COALESCE(slv.sq, 0) AS drift
      FROM "Product" p
      LEFT JOIN (SELECT "productId", SUM(quantity) sq FROM "StockLevel" GROUP BY "productId") slv
        ON slv."productId" = p.id
      WHERE p."isParent" = false
        AND p."totalStock" != COALESCE(slv.sq, 0)
    ) drift_set
    JOIN "Product" p ON p.id = drift_set.id
  `)
  const skus = r.rows[0].drifted_skus
  record('Product.totalStock = SUM(StockLevel.quantity)', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} drifted SKUs: ${(skus ?? []).slice(0, 5).join(', ')}` : null)
}

// 3. No negative quantities
{
  const r = await c.query(`SELECT count(*)::int n FROM "StockLevel" WHERE quantity < 0`)
  record('no negative StockLevel.quantity', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} rows` : null)
}

// 4. No negative available (oversell signal)
{
  const r = await c.query(`SELECT count(*)::int n FROM "StockLevel" WHERE available < 0`)
  record('no negative StockLevel.available (no oversell)', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} rows oversold` : null)
}

// 5. S.1 — no NEW shadow-path movements created after S.1 deploy
//    Heuristic: shadow path used referenceType='inventory-sync.service'.
//    Pre-S.1 some legitimate rows may exist; we check for any such row
//    in the last 24h (i.e., after Wave 1 should have shipped).
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "StockMovement"
    WHERE "referenceType" = 'inventory-sync.service'
      AND "createdAt" > now() - interval '24 hours'
  `)
  record('S.1: zero new shadow-path StockMovements in last 24h', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} rows — shadow path may still be live` : null)
}

// 6. Every recent StockMovement has locationId — H.1 invariant
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "StockMovement"
    WHERE "locationId" IS NULL
      AND "createdAt" > now() - interval '7 days'
      AND reason != 'PARENT_PRODUCT_CLEANUP'   -- migration backfill exception
  `)
  record('every recent StockMovement carries a locationId', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} rows in last 7d missing locationId` : null)
}

// 7. Every quantity-changing StockMovement has quantityBefore — H.1
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "StockMovement"
    WHERE "quantityBefore" IS NULL
      AND change != 0
      AND "createdAt" > now() - interval '7 days'
      AND reason != 'PARENT_PRODUCT_CLEANUP'
  `)
  record('every recent quantity-changing movement has quantityBefore', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} rows missing quantityBefore` : null)
}

// 8. S.2 — open reservations (OPEN_ORDER) carry orderId
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "StockReservation"
    WHERE reason = 'OPEN_ORDER'
      AND "orderId" IS NULL
      AND "releasedAt" IS NULL AND "consumedAt" IS NULL
  `)
  record('S.2: every active OPEN_ORDER reservation carries an orderId', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} orphan reservations` : null)
}

// 9. Stale reservations — operational signal, not an invariant.
//    Active OPEN_ORDER reservations older than 30 days = an order
//    that's been open for a month. Worth surfacing.
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "StockReservation"
    WHERE reason = 'OPEN_ORDER'
      AND "releasedAt" IS NULL AND "consumedAt" IS NULL
      AND "createdAt" < now() - interval '30 days'
  `)
  record('S.2: no OPEN_ORDER reservations stale > 30 days', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} stale reservations — investigate` : null)
}

// 10. PENDING_ORDER reservations past expiresAt should be empty
//     (the reservation-sweep cron should release them)
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "StockReservation"
    WHERE reason = 'PENDING_ORDER'
      AND "releasedAt" IS NULL AND "consumedAt" IS NULL
      AND "expiresAt" < now()
  `)
  record('reservation-sweep: zero expired PENDING_ORDER reservations', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} expired and not swept — cron may be down` : null)
}

// 11. FBA cron freshness — last reconciliation must be in the last 90 min
//     (cron is 15 min; 90 min covers the cron + a couple of skipped runs)
{
  const r = await c.query(`
    SELECT max("createdAt") AS last_at,
      EXTRACT(epoch FROM (now() - max("createdAt"))) / 60 AS minutes_ago
    FROM "StockMovement"
    WHERE reason = 'SYNC_RECONCILIATION'
      AND actor = 'system:amazon-inventory-cron'
  `)
  const minutesAgo = r.rows[0].minutes_ago != null ? parseFloat(r.rows[0].minutes_ago) : null
  if (minutesAgo == null) {
    // Acceptable if FBA cron has never run (gated behind env var)
    record('FBA cron freshness', true, 'never run (cron may be disabled)')
  } else if (minutesAgo <= 90) {
    record('FBA cron last reconciliation < 90 min ago', true, `${Math.round(minutesAgo)} min ago`)
  } else {
    record('FBA cron last reconciliation < 90 min ago', false, `${Math.round(minutesAgo)} min ago — cron may be stuck`)
  }
}

// 12. ChannelListing.masterQuantity drift vs Product.totalStock
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "ChannelListing" cl
    JOIN "Product" p ON p.id = cl."productId"
    WHERE cl."masterQuantity" IS NOT NULL
      AND cl."masterQuantity" != p."totalStock"
  `)
  record('ChannelListing.masterQuantity matches Product.totalStock', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} listings drifted` : null)
}

// 13. ChannelListing.followMasterQuantity contract — when true, the
//     listing's `quantity` should equal max(0, masterQuantity - stockBuffer)
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "ChannelListing"
    WHERE "followMasterQuantity" = true
      AND "masterQuantity" IS NOT NULL
      AND quantity != GREATEST(0, "masterQuantity" - COALESCE("stockBuffer", 0))
      AND "lastSyncStatus" != 'PENDING'
  `)
  record('followMasterQuantity contract holds (synced listings)', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} listings drifted from master - buffer` : null)
}

// 14. OutboundSyncQueue: no QUANTITY_UPDATE pending > 1h (stuck queue)
{
  const r = await c.query(`
    SELECT count(*)::int n FROM "OutboundSyncQueue"
    WHERE "syncType" = 'QUANTITY_UPDATE'
      AND "syncStatus" = 'PENDING'
      AND "createdAt" < now() - interval '1 hour'
  `)
  record('OutboundSyncQueue QUANTITY_UPDATE not stuck > 1h', r.rows[0].n === 0,
    r.rows[0].n > 0 ? `${r.rows[0].n} stuck — drain may be down` : null)
}

// 15. S.1 sanity: the deleted shadow service file is gone (filesystem)
{
  const fs = await import('node:fs')
  const shadowPath = path.join(here, '..', 'apps/api/src/services/inventory-sync.service.ts')
  const exists = fs.existsSync(shadowPath)
  record('S.1: shadow inventory-sync.service.ts file removed', !exists,
    exists ? `still present at ${shadowPath}` : null)
}

await c.end()

const failed = checks.filter((c) => !c.pass).length
const passed = checks.length - failed

if (JSON_MODE) {
  console.log(JSON.stringify({
    pass: failed === 0,
    passed,
    failed,
    checks: checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
  }, null, 2))
} else {
  console.log()
  console.log(`[stock health] ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log()
    for (const c of checks.filter((c) => !c.pass)) {
      console.log(`  ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    }
  }
}

process.exit(failed === 0 ? 0 : 1)
