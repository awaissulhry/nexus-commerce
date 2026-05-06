#!/usr/bin/env node
// Bulk-operations Commit 1 verification.
//
// Asserts that the variant-mechanism + channel-cascade pairing works:
//   1. Bulk PRICING_UPDATE on a real product with a ChannelListing →
//      Product.basePrice updated, ChannelListing.price + .masterPrice
//      cascaded, OutboundSyncQueue row inserted (PENDING), AuditLog
//      written.
//   2. Bulk INVENTORY_UPDATE → Product.totalStock updated via
//      StockLevel ledger, StockMovement audit row created with
//      referenceType='BulkActionJob', ChannelListing.quantity +
//      .masterQuantity cascaded.
//   3. Idempotency — re-running the same PRICING job is a no-op via
//      MasterPriceService short-circuit (no new audit / queue rows).
//   4. Filter-driven scope — bulk PRICING with brand filter matches
//      multiple products and processes all of them.
//
// Note on BullMQ: bulk-action passes skipBullMQEnqueue=true (see
// TECH_DEBT #54). We only assert the OutboundSyncQueue *DB rows*
// exist; the cron worker (sync.worker.ts) drains them on its own.
//
// Strategy: pick one real Xavia product that has at least one
// ChannelListing, snapshot its full state, run each scenario,
// assert, then restore the snapshot. Test is destructive during
// execution but leaves the DB in its original state on exit.
//
// Usage:
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
//     node scripts/verify-bulk-c1.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

let pass = 0
let fail = 0
const failures = []
const createdJobIds = []
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
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

async function pollJob(jobId, timeoutMs = 60000) {
  const start = Date.now()
  const terminal = new Set([
    'COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED', 'CANCELLED',
  ])
  let lastStatus = null
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/api/bulk-operations/${jobId}`)
    if (r.ok && r.data?.job) {
      const j = r.data.job
      if (j.status !== lastStatus) {
        console.log(`  [poll] ${jobId.slice(-8)} status=${j.status} processed=${j.processedItems}/${j.totalItems} failed=${j.failedItems}`)
        lastStatus = j.status
      }
      if (terminal.has(j.status)) return j
    } else if (!r.ok) {
      console.log(`  [poll] HTTP ${r.status} ${JSON.stringify(r.data).slice(0,150)}`)
    }
    await new Promise((res) => setTimeout(res, 1500))
  }
  const dbRow = (await client.query(
    `SELECT id, status, "processedItems", "failedItems", "totalItems", "lastError"
     FROM "BulkActionJob" WHERE id = $1`,
    [jobId],
  )).rows[0]
  throw new Error(`pollJob timeout — DB state: ${JSON.stringify(dbRow)}`)
}

async function snapshotProduct(productId) {
  const product = (await client.query(
    `SELECT id, sku, "basePrice", "totalStock", brand, "parentId", status
     FROM "Product" WHERE id = $1`,
    [productId],
  )).rows[0]
  const listings = (await client.query(
    `SELECT id, channel, marketplace, price, "masterPrice", quantity,
            "masterQuantity", "stockBuffer", "followMasterPrice",
            "followMasterQuantity", "pricingRule", "lastSyncStatus", version
     FROM "ChannelListing" WHERE "productId" = $1`,
    [productId],
  )).rows
  // Snapshot every StockLevel row so restore can rewrite quantity AND
  // available coherently (the table has a check constraint that
  // enforces available = quantity - reserved).
  const stockLevels = (await client.query(
    `SELECT id, quantity, reserved, available
     FROM "StockLevel" WHERE "productId" = $1`,
    [productId],
  )).rows
  return { product, listings, stockLevels }
}

async function restoreProduct(snap) {
  const p = snap.product
  await client.query(
    `UPDATE "Product"
     SET "basePrice" = $2, "totalStock" = $3, status = $4
     WHERE id = $1`,
    [p.id, p.basePrice, p.totalStock, p.status],
  )
  for (const l of snap.listings) {
    await client.query(
      `UPDATE "ChannelListing"
       SET price = $2, "masterPrice" = $3, quantity = $4, "masterQuantity" = $5,
           "lastSyncStatus" = $6, version = $7
       WHERE id = $1`,
      [l.id, l.price, l.masterPrice, l.quantity, l.masterQuantity,
        l.lastSyncStatus, l.version],
    )
  }
  // Restore each StockLevel row from snapshot. Set quantity, reserved,
  // available together so the StockLevel_available_invariant constraint
  // (available = quantity - reserved) is respected.
  for (const sl of snap.stockLevels) {
    await client.query(
      `UPDATE "StockLevel"
       SET quantity = $2, reserved = $3, available = $4
       WHERE id = $1`,
      [sl.id, sl.quantity, sl.reserved, sl.available],
    )
  }
  // Any StockLevel rows created by applyStockMovement during the test
  // (i.e. rows that didn't exist at snapshot time) get zeroed out.
  // applyStockMovement creates a row when none exists for the
  // (location, product, variation) tuple — the test's INVENTORY +5
  // would create one if no row existed yet.
  const snapshotIds = snap.stockLevels.map((s) => s.id)
  if (snapshotIds.length > 0) {
    await client.query(
      `UPDATE "StockLevel"
       SET quantity = 0, reserved = 0, available = 0
       WHERE "productId" = $1 AND id <> ALL($2::text[])`,
      [p.id, snapshotIds],
    )
  } else {
    await client.query(
      `UPDATE "StockLevel"
       SET quantity = 0, reserved = 0, available = 0
       WHERE "productId" = $1`,
      [p.id],
    )
  }
}

let target
let snapshot

try {
  // ── Pick a real product with at least 1 ChannelListing ─────────────
  const candidate = (await client.query(`
    SELECT p.id, p.sku, p.brand, p."basePrice", p."totalStock"
    FROM "Product" p
    INNER JOIN "ChannelListing" cl ON cl."productId" = p.id
    WHERE p."isParent" = false
      AND p."basePrice" IS NOT NULL
      AND p."basePrice" > 0
      AND p.brand IS NOT NULL
    ORDER BY p."updatedAt" DESC
    LIMIT 1
  `)).rows[0]
  if (!candidate) {
    console.log('No suitable test product found. Aborting.')
    process.exit(1)
  }
  target = candidate
  snapshot = await snapshotProduct(target.id)
  const baseline = Number(snapshot.product.basePrice)
  console.log(`Using product ${target.sku} (id=${target.id}, basePrice=${baseline}, listings=${snapshot.listings.length})`)

  // ── 1. Happy path PRICING ──────────────────────────────────────────
  const newPrice = +(baseline + 1.23).toFixed(2)
  const queueRowsBefore = (await client.query(
    `SELECT COUNT(*)::int AS c FROM "OutboundSyncQueue"
     WHERE "productId" = $1 AND "syncType" = 'PRICE_UPDATE'`,
    [target.id],
  )).rows[0].c

  const create1 = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-c1-pricing-happy',
    actionType: 'PRICING_UPDATE',
    targetProductIds: [target.id],
    actionPayload: { adjustmentType: 'ABSOLUTE', value: newPrice },
  })
  if (!create1.ok || !create1.data?.job?.id) {
    bad('PRICING create', `status=${create1.status} body=${JSON.stringify(create1.data).slice(0,200)}`)
    throw new Error('Cannot continue without created job')
  }
  createdJobIds.push(create1.data.job.id)
  await api('POST', `/api/bulk-operations/${create1.data.job.id}/process`)
  const j1 = await pollJob(create1.data.job.id)

  if (j1.status === 'COMPLETED' && j1.processedItems === 1) {
    ok('PRICING job COMPLETED with 1 processed item')
  } else {
    bad('PRICING job state',
      `status=${j1.status} processed=${j1.processedItems} failed=${j1.failedItems} ` +
      `total=${j1.totalItems} lastError=${j1.lastError ?? '(none)'}`)
  }

  const after1 = await snapshotProduct(target.id)
  if (Math.abs(Number(after1.product.basePrice) - newPrice) < 0.01) {
    ok(`Product.basePrice updated to ${newPrice}`)
  } else {
    bad('Product.basePrice not updated', `expected=${newPrice} got=${after1.product.basePrice}`)
  }

  const cascadedListings = after1.listings.filter((l) =>
    Math.abs(Number(l.masterPrice ?? 0) - newPrice) < 0.01,
  )
  if (cascadedListings.length === snapshot.listings.length) {
    ok(`ChannelListing.masterPrice cascaded to all ${cascadedListings.length} listings`)
  } else {
    bad('ChannelListing.masterPrice cascade incomplete',
      `${cascadedListings.length}/${snapshot.listings.length} listings cascaded`)
  }

  const queueRowsAfter = (await client.query(
    `SELECT COUNT(*)::int AS c FROM "OutboundSyncQueue"
     WHERE "productId" = $1 AND "syncType" = 'PRICE_UPDATE'
       AND "createdAt" > NOW() - INTERVAL '120 seconds'`,
    [target.id],
  )).rows[0].c
  if (queueRowsAfter > 0) {
    ok(`OutboundSyncQueue PRICE_UPDATE row inserted (${queueRowsAfter} recent rows)`)
  } else {
    bad('OutboundSyncQueue not enqueued', `before=${queueRowsBefore} after=${queueRowsAfter}`)
  }

  const auditRows = (await client.query(
    `SELECT id, action, metadata FROM "AuditLog"
     WHERE "entityId" = $1
       AND "entityType" = 'Product'
       AND action = 'update'
       AND metadata->>'field' = 'basePrice'
       AND "createdAt" > NOW() - INTERVAL '120 seconds'`,
    [target.id],
  )).rows
  if (auditRows.length >= 1) {
    ok(`AuditLog basePrice-update entry created`)
  } else {
    bad('AuditLog not written', `0 basePrice update rows for product in last 120s`)
  }

  // ── 2. INVENTORY happy path ────────────────────────────────────────
  const baselineStock = Number(after1.product.totalStock ?? 0)
  const create2 = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-c1-inventory-happy',
    actionType: 'INVENTORY_UPDATE',
    targetProductIds: [target.id],
    actionPayload: { adjustmentType: 'DELTA', value: 5 },
  })
  if (!create2.ok || !create2.data?.job?.id) {
    bad('INVENTORY create', `status=${create2.status}`)
  } else {
    createdJobIds.push(create2.data.job.id)
    await api('POST', `/api/bulk-operations/${create2.data.job.id}/process`)
    const j2 = await pollJob(create2.data.job.id)
    if (j2.status === 'COMPLETED' && j2.processedItems === 1) {
      ok('INVENTORY job COMPLETED with 1 processed item')
    } else {
      bad('INVENTORY job state', `status=${j2.status} processed=${j2.processedItems} failed=${j2.failedItems} lastError=${j2.lastError ?? ''}`)
    }
    const after2 = await snapshotProduct(target.id)
    const stockDelta = Number(after2.product.totalStock) - baselineStock
    if (stockDelta === 5) {
      ok(`Product.totalStock increased by 5 (${baselineStock} → ${after2.product.totalStock})`)
    } else {
      bad('Product.totalStock delta', `expected=+5 got=${stockDelta}`)
    }
    const movement = (await client.query(
      `SELECT id, change, reason, "referenceType", "referenceId" FROM "StockMovement"
       WHERE "productId" = $1 AND "referenceType" = 'BulkActionJob'
       ORDER BY "createdAt" DESC LIMIT 1`,
      [target.id],
    )).rows[0]
    if (movement && movement.change === 5 && movement.referenceId === create2.data.job.id) {
      ok(`StockMovement audit row created (referenceType=BulkActionJob, change=+5)`)
    } else {
      bad('StockMovement not created', `row=${JSON.stringify(movement)}`)
    }
  }

  // ── 3. Idempotency ──────────────────────────────────────────────────
  const auditCountBefore3 = (await client.query(
    `SELECT COUNT(*)::int AS c FROM "AuditLog"
     WHERE "entityId" = $1 AND "entityType" = 'Product'
       AND metadata->>'field' = 'basePrice'`,
    [target.id],
  )).rows[0].c

  const create3 = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-c1-pricing-idempotent',
    actionType: 'PRICING_UPDATE',
    targetProductIds: [target.id],
    actionPayload: { adjustmentType: 'ABSOLUTE', value: newPrice },
  })
  if (create3.ok && create3.data?.job?.id) {
    createdJobIds.push(create3.data.job.id)
    await api('POST', `/api/bulk-operations/${create3.data.job.id}/process`)
    const j3 = await pollJob(create3.data.job.id)
    const auditCountAfter3 = (await client.query(
      `SELECT COUNT(*)::int AS c FROM "AuditLog"
       WHERE "entityId" = $1 AND "entityType" = 'Product'
         AND metadata->>'field' = 'basePrice'`,
      [target.id],
    )).rows[0].c
    if (auditCountAfter3 === auditCountBefore3) {
      ok(`Idempotency: re-running same PRICING job produced 0 new AuditLog rows (still ${auditCountAfter3})`)
    } else {
      bad('Idempotency: AuditLog grew on no-op rerun',
        `before=${auditCountBefore3} after=${auditCountAfter3}`)
    }
    if (j3.status === 'COMPLETED') {
      ok('Idempotent re-run still reports COMPLETED at job level')
    } else {
      bad('Idempotent re-run unexpected status', `status=${j3.status}`)
    }
  }

  // ── 4. Filter-driven scope ──────────────────────────────────────────
  const sameBrandCount = (await client.query(
    `SELECT COUNT(*)::int AS c FROM "Product"
     WHERE brand = $1 AND "basePrice" IS NOT NULL`,
    [target.brand],
  )).rows[0].c
  if (sameBrandCount < 2) {
    console.log(`Skipping filter-scope test — only ${sameBrandCount} product with brand=${target.brand}`)
  } else {
    const create4 = await api('POST', '/api/bulk-operations', {
      jobName: 'verify-c1-pricing-filter',
      actionType: 'PRICING_UPDATE',
      filters: { brand: target.brand },
      actionPayload: { adjustmentType: 'PERCENT', value: 0 },
    })
    if (create4.ok && create4.data?.job?.id) {
      createdJobIds.push(create4.data.job.id)
      await api('POST', `/api/bulk-operations/${create4.data.job.id}/process`)
      const j4 = await pollJob(create4.data.job.id, 120000)
      if (j4.totalItems === sameBrandCount) {
        ok(`Filter-scope: PRICING with brand=${target.brand} matched ${sameBrandCount} products`)
      } else {
        bad('Filter-scope item count mismatch',
          `expected=${sameBrandCount} got totalItems=${j4.totalItems}`)
      }
    }
  }

} finally {
  // ── Cleanup ─────────────────────────────────────────────────────────
  console.log('\nCleaning up...')
  if (snapshot) {
    await restoreProduct(snapshot)
    console.log(`  restored ${snapshot.listings.length} listings + Product baseline`)
  }
  if (createdJobIds.length > 0) {
    const r = await client.query(
      `DELETE FROM "BulkActionJob" WHERE id = ANY($1::text[])`,
      [createdJobIds],
    )
    console.log(`  deleted ${r.rowCount} verification job(s)`)
  }
  if (createdJobIds.length > 0) {
    const r1 = await client.query(
      `DELETE FROM "StockMovement" WHERE "referenceType" = 'BulkActionJob' AND "referenceId" = ANY($1::text[])`,
      [createdJobIds],
    )
    console.log(`  deleted ${r1.rowCount} StockMovement audit row(s)`)
  }
  // PENDING OutboundSyncQueue rows from cascade — delete so the cron
  // worker doesn't push our test prices to the marketplace.
  if (target) {
    const r2 = await client.query(
      `DELETE FROM "OutboundSyncQueue"
       WHERE "productId" = $1 AND "createdAt" > NOW() - INTERVAL '15 minutes'
         AND "syncStatus" = 'PENDING'`,
      [target.id],
    )
    console.log(`  deleted ${r2.rowCount} pending OutboundSyncQueue row(s) for test product`)
  }
  await client.end()
}

console.log(`\n${pass} pass / ${fail} fail`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
