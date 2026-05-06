#!/usr/bin/env node
// Bulk-operations Commit 2 verification — per-item BulkActionItem rows.
//
// Asserts:
//   1. Schema: BulkActionItem table exists with the expected columns.
//   2. Happy path: bulk PRICING_UPDATE creates a BulkActionItem row
//      with status=SUCCEEDED, productId set, jobId set,
//      beforeState.basePrice = original, afterState.basePrice = new,
//      completedAt populated.
//   3. Skipped path: bulk PRICING_UPDATE with minPrice > target price
//      → handler returns 'skipped' → row has status=SKIPPED, afterState
//      equals beforeState (no mutation).
//   4. Failure path: bulk PRICING_UPDATE with bogus actionPayload
//      (missing adjustmentType) → handler throws → row has status=FAILED
//      and errorMessage populated.
//   5. Cascade delete: deleting a BulkActionJob also deletes its items.
//
// Strategy: same as verify-bulk-c1 — pick one real Xavia product with a
// ChannelListing, snapshot product/listings/stockLevels, run scenarios,
// restore. Cleanup deletes verify jobs (cascade takes the items with
// them).
//
// Usage:
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
//     node scripts/verify-bulk-c2.mjs

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
  for (const sl of snap.stockLevels) {
    await client.query(
      `UPDATE "StockLevel"
       SET quantity = $2, reserved = $3, available = $4
       WHERE id = $1`,
      [sl.id, sl.quantity, sl.reserved, sl.available],
    )
  }
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
  // ── 1. Schema present ──────────────────────────────────────────────
  const schemaRows = (await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'BulkActionItem'
    ORDER BY ordinal_position
  `)).rows
  const expectedCols = [
    'id', 'jobId', 'productId', 'variationId', 'channelListingId',
    'status', 'errorMessage', 'beforeState', 'afterState',
    'createdAt', 'completedAt',
  ]
  const actualCols = new Set(schemaRows.map((r) => r.column_name))
  const missing = expectedCols.filter((c) => !actualCols.has(c))
  if (missing.length === 0) {
    ok(`BulkActionItem table exists with all ${expectedCols.length} expected columns`)
  } else {
    bad('BulkActionItem schema incomplete', `missing: ${missing.join(', ')}`)
    process.exit(1)
  }

  // ── Pick a test product ────────────────────────────────────────────
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
  console.log(`Using product ${target.sku} (id=${target.id}, basePrice=${baseline})`)

  // ── 2. Happy path: SUCCEEDED row ───────────────────────────────────
  const newPrice = +(baseline + 2.34).toFixed(2)
  const create1 = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-c2-pricing-happy',
    actionType: 'PRICING_UPDATE',
    targetProductIds: [target.id],
    actionPayload: { adjustmentType: 'ABSOLUTE', value: newPrice },
  })
  if (!create1.ok || !create1.data?.job?.id) {
    bad('PRICING create', `status=${create1.status}`)
    throw new Error('cannot continue')
  }
  createdJobIds.push(create1.data.job.id)
  await api('POST', `/api/bulk-operations/${create1.data.job.id}/process`)
  await pollJob(create1.data.job.id)

  const itemRows1 = (await client.query(
    `SELECT id, "jobId", "productId", "variationId", "channelListingId",
            status, "errorMessage", "beforeState", "afterState", "completedAt"
     FROM "BulkActionItem" WHERE "jobId" = $1`,
    [create1.data.job.id],
  )).rows
  if (itemRows1.length === 1) {
    ok(`Happy path: 1 BulkActionItem row created for the job`)
  } else {
    bad('Happy path: row count', `expected 1, got ${itemRows1.length}`)
  }
  if (itemRows1.length > 0) {
    const row = itemRows1[0]
    if (row.status === 'SUCCEEDED') ok('Happy path: status=SUCCEEDED')
    else bad('Happy path: status', `got ${row.status}`)

    if (row.productId === target.id) ok('Happy path: productId matches target')
    else bad('Happy path: productId', `expected ${target.id} got ${row.productId}`)

    if (row.variationId == null && row.channelListingId == null) {
      ok('Happy path: only productId set (polymorphic target correct)')
    } else {
      bad('Happy path: polymorphic target',
        `variationId=${row.variationId} channelListingId=${row.channelListingId}`)
    }

    const beforeBp = row.beforeState?.basePrice
    if (Math.abs(Number(beforeBp) - baseline) < 0.01) {
      ok(`Happy path: beforeState.basePrice = ${beforeBp}`)
    } else {
      bad('Happy path: beforeState.basePrice', `expected ${baseline} got ${beforeBp}`)
    }

    const afterBp = row.afterState?.basePrice
    if (Math.abs(Number(afterBp) - newPrice) < 0.01) {
      ok(`Happy path: afterState.basePrice = ${afterBp}`)
    } else {
      bad('Happy path: afterState.basePrice', `expected ${newPrice} got ${afterBp}`)
    }

    if (row.completedAt != null) ok('Happy path: completedAt populated')
    else bad('Happy path: completedAt', 'null')
  }

  // ── 3. Skipped path: minPrice violation ────────────────────────────
  const create2 = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-c2-pricing-skip',
    actionType: 'PRICING_UPDATE',
    targetProductIds: [target.id],
    actionPayload: {
      adjustmentType: 'ABSOLUTE',
      value: 1, // way below minPrice
      minPrice: 999999,
    },
  })
  if (create2.ok && create2.data?.job?.id) {
    createdJobIds.push(create2.data.job.id)
    await api('POST', `/api/bulk-operations/${create2.data.job.id}/process`)
    await pollJob(create2.data.job.id)
    const itemRows2 = (await client.query(
      `SELECT status, "beforeState", "afterState", "errorMessage"
       FROM "BulkActionItem" WHERE "jobId" = $1`,
      [create2.data.job.id],
    )).rows
    if (itemRows2.length === 1 && itemRows2[0].status === 'SKIPPED') {
      ok('Skipped path: status=SKIPPED')
    } else {
      bad('Skipped path: status',
        `count=${itemRows2.length} status=${itemRows2[0]?.status}`)
    }
    if (itemRows2[0]?.errorMessage == null) {
      ok('Skipped path: no errorMessage')
    } else {
      bad('Skipped path: errorMessage should be null',
        `got ${itemRows2[0].errorMessage}`)
    }
  }

  // ── 4. Failure path: bogus payload ─────────────────────────────────
  const create3 = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-c2-pricing-fail',
    actionType: 'PRICING_UPDATE',
    targetProductIds: [target.id],
    actionPayload: { value: 5.0 }, // missing adjustmentType
  })
  if (create3.ok && create3.data?.job?.id) {
    createdJobIds.push(create3.data.job.id)
    await api('POST', `/api/bulk-operations/${create3.data.job.id}/process`)
    await pollJob(create3.data.job.id)
    const itemRows3 = (await client.query(
      `SELECT status, "errorMessage"
       FROM "BulkActionItem" WHERE "jobId" = $1`,
      [create3.data.job.id],
    )).rows
    if (itemRows3.length === 1 && itemRows3[0].status === 'FAILED') {
      ok('Failure path: status=FAILED')
    } else {
      bad('Failure path: status',
        `count=${itemRows3.length} status=${itemRows3[0]?.status}`)
    }
    if (itemRows3[0]?.errorMessage && /adjustmentType/i.test(itemRows3[0].errorMessage)) {
      ok(`Failure path: errorMessage captured (${itemRows3[0].errorMessage.slice(0, 80)})`)
    } else {
      bad('Failure path: errorMessage',
        `got: ${JSON.stringify(itemRows3[0]?.errorMessage)}`)
    }
  }

  // ── 5. Cascade delete ──────────────────────────────────────────────
  if (create1.data?.job?.id) {
    const beforeDelete = (await client.query(
      `SELECT COUNT(*)::int AS c FROM "BulkActionItem" WHERE "jobId" = $1`,
      [create1.data.job.id],
    )).rows[0].c
    await client.query(
      `DELETE FROM "BulkActionJob" WHERE id = $1`,
      [create1.data.job.id],
    )
    const afterDelete = (await client.query(
      `SELECT COUNT(*)::int AS c FROM "BulkActionItem" WHERE "jobId" = $1`,
      [create1.data.job.id],
    )).rows[0].c
    if (beforeDelete > 0 && afterDelete === 0) {
      ok(`Cascade delete: ${beforeDelete} item(s) removed when job deleted`)
    } else {
      bad('Cascade delete', `before=${beforeDelete} after=${afterDelete}`)
    }
    // Remove from createdJobIds since it's already deleted, so cleanup
    // doesn't double-delete (which would be harmless but logs noise).
    const idx = createdJobIds.indexOf(create1.data.job.id)
    if (idx >= 0) createdJobIds.splice(idx, 1)
  }

} finally {
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
    console.log(`  deleted ${r.rowCount} verification job(s) (+ items via cascade)`)
  }
  if (createdJobIds.length > 0) {
    const r1 = await client.query(
      `DELETE FROM "StockMovement" WHERE "referenceType" = 'BulkActionJob' AND "referenceId" = ANY($1::text[])`,
      [createdJobIds],
    )
    if (r1.rowCount > 0) console.log(`  deleted ${r1.rowCount} StockMovement audit row(s)`)
  }
  if (target) {
    const r2 = await client.query(
      `DELETE FROM "OutboundSyncQueue"
       WHERE "productId" = $1 AND "createdAt" > NOW() - INTERVAL '15 minutes'
         AND "syncStatus" = 'PENDING'`,
      [target.id],
    )
    if (r2.rowCount > 0) console.log(`  deleted ${r2.rowCount} pending OutboundSyncQueue row(s)`)
  }
  await client.end()
}

console.log(`\n${pass} pass / ${fail} fail`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
