#!/usr/bin/env node
// Verify the Job History endpoints (GET /api/bulk-operations/history,
// GET /api/bulk-operations/:id/items) added in the Tier-1 UX commit.
//
// Strategy: create a real bulk PRICING_UPDATE job + run it (so we
// have a non-trivial BulkActionItem row to drill into), then assert
// both endpoints return the expected shape with the expected data.
// Cleanup restores the test product baseline.
//
// Usage:
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
//     node scripts/verify-bulk-history.mjs

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
  const terminal = new Set(['COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED', 'CANCELLED'])
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/api/bulk-operations/${jobId}`)
    if (r.ok && r.data?.job && terminal.has(r.data.job.status)) return r.data.job
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error(`pollJob timeout for ${jobId}`)
}

async function snapshotProduct(productId) {
  const product = (await client.query(
    `SELECT id, sku, "basePrice", "totalStock", brand, status FROM "Product" WHERE id = $1`,
    [productId],
  )).rows[0]
  const listings = (await client.query(
    `SELECT id, price, "masterPrice", quantity, "masterQuantity",
            "lastSyncStatus", version FROM "ChannelListing" WHERE "productId" = $1`,
    [productId],
  )).rows
  const stockLevels = (await client.query(
    `SELECT id, quantity, reserved, available FROM "StockLevel" WHERE "productId" = $1`,
    [productId],
  )).rows
  return { product, listings, stockLevels }
}

async function restoreProduct(snap) {
  const p = snap.product
  await client.query(
    `UPDATE "Product" SET "basePrice" = $2, "totalStock" = $3, status = $4 WHERE id = $1`,
    [p.id, p.basePrice, p.totalStock, p.status],
  )
  for (const l of snap.listings) {
    await client.query(
      `UPDATE "ChannelListing" SET price = $2, "masterPrice" = $3, quantity = $4,
       "masterQuantity" = $5, "lastSyncStatus" = $6, version = $7 WHERE id = $1`,
      [l.id, l.price, l.masterPrice, l.quantity, l.masterQuantity, l.lastSyncStatus, l.version],
    )
  }
  for (const sl of snap.stockLevels) {
    await client.query(
      `UPDATE "StockLevel" SET quantity = $2, reserved = $3, available = $4 WHERE id = $1`,
      [sl.id, sl.quantity, sl.reserved, sl.available],
    )
  }
}

let target
let snapshot

try {
  // ── Setup: create a real job so we have something to query ────────
  const candidate = (await client.query(`
    SELECT p.id, p.sku, p."basePrice"
    FROM "Product" p
    INNER JOIN "ChannelListing" cl ON cl."productId" = p.id
    WHERE p."isParent" = false AND p."basePrice" IS NOT NULL AND p."basePrice" > 0
    ORDER BY p."updatedAt" DESC LIMIT 1
  `)).rows[0]
  if (!candidate) {
    console.log('No suitable test product found. Aborting.')
    process.exit(1)
  }
  target = candidate
  snapshot = await snapshotProduct(target.id)
  const baseline = Number(snapshot.product.basePrice)
  console.log(`Using product ${target.sku} (baseline=${baseline})`)

  const newPrice = +(baseline + 4.56).toFixed(2)
  const create = await api('POST', '/api/bulk-operations', {
    jobName: 'verify-history-test',
    actionType: 'PRICING_UPDATE',
    targetProductIds: [target.id],
    actionPayload: { adjustmentType: 'ABSOLUTE', value: newPrice },
  })
  if (!create.ok) {
    bad('Setup: create job', `status=${create.status}`)
    throw new Error('cannot continue')
  }
  createdJobIds.push(create.data.job.id)
  await api('POST', `/api/bulk-operations/${create.data.job.id}/process`)
  await pollJob(create.data.job.id)

  // ── 1. GET /history (no filter) ───────────────────────────────────
  const histRes = await api('GET', '/api/bulk-operations/history?limit=10')
  if (histRes.ok && Array.isArray(histRes.data?.jobs)) {
    ok(`/history returns array of jobs (count=${histRes.data.count})`)
  } else {
    bad('/history shape', `status=${histRes.status} body=${JSON.stringify(histRes.data).slice(0,200)}`)
  }
  const ourJob = histRes.data?.jobs?.find((j) => j.id === create.data.job.id)
  if (ourJob) {
    ok(`/history includes our newly-created job at the top of the list`)
    if (ourJob.jobName === 'verify-history-test') ok('/history job has correct jobName')
    else bad('/history jobName', `got ${ourJob.jobName}`)
    if (ourJob.actionType === 'PRICING_UPDATE') ok('/history job has correct actionType')
    else bad('/history actionType', `got ${ourJob.actionType}`)
    if (ourJob.totalItems === 1 && ourJob.processedItems === 1) {
      ok('/history job has correct totalItems / processedItems')
    } else {
      bad('/history counts', `totalItems=${ourJob.totalItems} processedItems=${ourJob.processedItems}`)
    }
  } else {
    bad('/history missing our job', `looked for id=${create.data.job.id}`)
  }

  // ── 2. GET /history?status=terminal (alias filter) ────────────────
  const histTerm = await api(
    'GET',
    '/api/bulk-operations/history?status=terminal&limit=5',
  )
  if (histTerm.ok && histTerm.data?.jobs) {
    const allTerminal = histTerm.data.jobs.every((j) =>
      ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status),
    )
    if (allTerminal) {
      ok(`/history?status=terminal returns only terminal jobs (got ${histTerm.data.jobs.length})`)
    } else {
      const offenders = histTerm.data.jobs.filter((j) => !['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status)).map((j) => j.status)
      bad('/history?status=terminal: non-terminal job leaked through', offenders.join(','))
    }
  } else {
    bad('/history?status=terminal', `status=${histTerm.status}`)
  }

  // ── 3. GET /:id/items ─────────────────────────────────────────────
  const itemsRes = await api(
    'GET',
    `/api/bulk-operations/${create.data.job.id}/items`,
  )
  if (itemsRes.ok && Array.isArray(itemsRes.data?.items)) {
    ok(`/:id/items returns array of items (count=${itemsRes.data.count})`)
  } else {
    bad('/:id/items shape', `status=${itemsRes.status}`)
  }
  if (itemsRes.data?.items?.length === 1) {
    const item = itemsRes.data.items[0]
    if (item.status === 'SUCCEEDED') ok('Item: status=SUCCEEDED')
    else bad('Item status', `got ${item.status}`)
    if (item.productId === target.id) ok('Item: productId matches target')
    else bad('Item productId', `expected ${target.id} got ${item.productId}`)
    if (item.sku === target.sku) {
      ok(`Item: SKU joined correctly (${item.sku})`)
    } else {
      bad('Item SKU join', `expected ${target.sku} got ${item.sku}`)
    }
    if (Math.abs(Number(item.beforeState?.basePrice) - baseline) < 0.01) {
      ok(`Item: beforeState.basePrice = ${item.beforeState.basePrice}`)
    } else {
      bad('Item beforeState.basePrice', `got ${item.beforeState?.basePrice}`)
    }
    if (Math.abs(Number(item.afterState?.basePrice) - newPrice) < 0.01) {
      ok(`Item: afterState.basePrice = ${item.afterState.basePrice}`)
    } else {
      bad('Item afterState.basePrice', `got ${item.afterState?.basePrice}`)
    }
  }

  // ── 4. /:id/items?status=FAILED filter (no failed items expected) ─
  const itemsFiltered = await api(
    'GET',
    `/api/bulk-operations/${create.data.job.id}/items?status=FAILED`,
  )
  if (itemsFiltered.ok && itemsFiltered.data?.items?.length === 0) {
    ok('/:id/items?status=FAILED filter works (0 failed items)')
  } else {
    bad('Items filter', `got ${itemsFiltered.data?.items?.length} failed items`)
  }

} finally {
  console.log('\nCleaning up...')
  if (snapshot) {
    await restoreProduct(snapshot)
    console.log(`  restored Product baseline + ${snapshot.listings.length} listings`)
  }
  if (createdJobIds.length > 0) {
    const r = await client.query(
      `DELETE FROM "BulkActionJob" WHERE id = ANY($1::text[])`,
      [createdJobIds],
    )
    console.log(`  deleted ${r.rowCount} verification job(s)`)
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
