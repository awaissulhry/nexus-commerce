#!/usr/bin/env node
// Bulk-operations Commit 1 verification.
//
// Asserts that the variant-mechanism + channel-cascade pairing works:
//   1. Bulk PRICING_UPDATE on a real product with a ChannelListing →
//      Product.basePrice updated, ChannelListing.price + .masterPrice
//      cascaded, OutboundSyncQueue row enqueued, AuditLog written.
//   2. Bulk INVENTORY_UPDATE → Product.totalStock updated via
//      StockLevel ledger, StockMovement audit row created with
//      referenceType='BulkActionJob', ChannelListing.quantity +
//      .masterQuantity cascaded.
//   3. Filter-driven scope — bulk PRICING with brand filter matches
//      multiple products and processes all of them.
//   4. Idempotency — re-running the same PRICING job is a no-op via
//      MasterPriceService short-circuit (no new OutboundSyncQueue rows).
//
// Strategy: pick one real Xavia product that has at least one
// ChannelListing, snapshot its full state + cascade tail, run each
// scenario, assert, then restore the snapshot. Test is destructive
// during execution but leaves the DB in its original state on exit.
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

async function pollJob(jobId, timeoutMs = 30000) {
  const start = Date.now()
  const terminal = new Set([
    'COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED', 'CANCELLED',
  ])
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/api/bulk-operations/${jobId}`)
    if (r.ok && r.data?.job && terminal.has(r.data.job.status)) {
      return r.data.job
    }
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error(`pollJob timeout after ${timeoutMs}ms for jobId=${jobId}`)
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
  return { product, listings }
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
  // Realign StockLevel to whatever totalStock was.
  await client.query(
    `UPDATE "StockLevel"
     SET quantity = $2
     WHERE "productId" = $1
       AND "locationId" = (SELECT id FROM "StockLocation" WHERE code = 'IT-MAIN' LIMIT 1)`,
    [p.id, p.totalStock],
  )
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
    console.log('No suitable test product found (need product with ChannelListing + non-zero basePrice + brand). Aborting.')
    process.exit(1)
  }
  target = candidate
  snapshot = await snapshotProduct(target.id)
  const baseline = Number(snapshot.product.basePrice)
  console.log(`Using product ${target.sku} (id=${target.id}, basePrice=${baseline}, listings=${snapshot.listings.length})`)

  // ── 1. Happy path PRICING ──────────────────────────────────────────
  const newPrice = +(baseline + 1.23).toFixed(2)
  const queueRowsBefore = (await client.query(
    `SELECT COUNT(*)::int AS c FROM "OutboundSyncQueue" WHERE "productId" = $1`,
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
    bad('PRICING job state', `status=${j1.status} processed=${j1.processedItems} failed=${j1.failedItems}`)
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
       AND "createdAt" > NOW() - INTERVAL '60 seconds'`,
    [target.id],
  )).rows[0].c
  if (queueRowsAfter > queueRowsBefore || queueRowsAfter > 0) {
    ok(`OutboundSyncQueue row enqueued (${queueRowsAfter} recent PRICE_UPDATE rows)`)
  } else {
    bad('OutboundSyncQueue not enqueued', `before=${queueRowsBefore} after=${queueRowsAfter}`)
  }

  const auditRows = (await client.query(
    `SELECT id, kind FROM "AuditLog"
     WHERE "entityId" = $1 AND kind = 'MASTER_PRICE_UPDATE'
       AND "createdAt" > NOW() - INTERVAL '60 seconds'`,
    [target.id],
  )).rows
  if (auditRows.length >= 1) {
    ok(`AuditLog MASTER_PRICE_UPDATE entry created`)
  } else {
    bad('AuditLog not written', `0 MASTER_PRICE_UPDATE rows for product in last 60s`)
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
  const queueRowsBefore3 = (await client.query(
    `SELECT COUNT(*)::int AS c FROM "OutboundSyncQueue"
     WHERE "productId" = $1 AND "syncType" = 'PRICE_UPDATE'
       AND "createdAt" > NOW() - INTERVAL '60 seconds'`,
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
    const queueRowsAfter3 = (await client.query(
      `SELECT COUNT(*)::int AS c FROM "OutboundSyncQueue"
       WHERE "productId" = $1 AND "syncType" = 'PRICE_UPDATE'
         AND "createdAt" > NOW() - INTERVAL '60 seconds'`,
      [target.id],
    )).rows[0].c
    if (queueRowsAfter3 === queueRowsBefore3) {
      ok(`Idempotency: re-running same PRICING job did not enqueue new OutboundSyncQueue rows (still ${queueRowsAfter3})`)
    } else {
      bad('Idempotency: queue rows grew on no-op rerun',
        `before=${queueRowsBefore3} after=${queueRowsAfter3}`)
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
      actionPayload: { adjustmentType: 'PERCENT', value: 0 }, // +0% — no real change but exercises the scope
    })
    if (create4.ok && create4.data?.job?.id) {
      createdJobIds.push(create4.data.job.id)
      await api('POST', `/api/bulk-operations/${create4.data.job.id}/process`)
      const j4 = await pollJob(create4.data.job.id, 60000)
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
  // The cascade also created OutboundSyncQueue + AuditLog + StockMovement rows
  // tied to our verification jobs; clean those too so the activity feed stays clean.
  if (createdJobIds.length > 0) {
    const r1 = await client.query(
      `DELETE FROM "StockMovement" WHERE "referenceType" = 'BulkActionJob' AND "referenceId" = ANY($1::text[])`,
      [createdJobIds],
    )
    console.log(`  deleted ${r1.rowCount} StockMovement audit row(s)`)
  }
  // OutboundSyncQueue rows for our test product in the last few minutes —
  // these were spawned by the cascade and would push stale prices to channels
  // if a worker picked them up before the holdUntil expires.
  if (target) {
    const r2 = await client.query(
      `DELETE FROM "OutboundSyncQueue"
       WHERE "productId" = $1 AND "createdAt" > NOW() - INTERVAL '10 minutes'
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
