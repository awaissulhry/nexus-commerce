/**
 * One-time 12-month Amazon order backfill.
 *
 * Calls POST /api/amazon/orders/sync with daysBack=365.
 * The SP-API service paginates all results and upserts idempotently.
 *
 * Usage:
 *   NEXUS_API_URL=https://nexusapi-production-b7bb.up.railway.app \
 *   node scripts/backfill-amazon-orders-12m.mjs
 *
 * Or locally (server must be running on port 3001):
 *   node scripts/backfill-amazon-orders-12m.mjs
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const BACKEND = process.env.NEXUS_API_URL ?? 'http://localhost:3001'
const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? '365', 10)

console.log(`[backfill] Syncing Amazon orders for last ${DAYS_BACK} days via ${BACKEND}`)

const start = Date.now()
const res = await fetch(`${BACKEND}/api/amazon/orders/sync`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ daysBack: DAYS_BACK }),
}).catch(err => { console.error('Network error:', err.message); process.exit(1) })

if (!res.ok) {
  const text = await res.text().catch(() => '(no body)')
  console.error(`[backfill] HTTP ${res.status}: ${text}`)
  process.exit(1)
}

const data = await res.json()
const elapsed = Math.round((Date.now() - start) / 1000)

console.log(`[backfill] Done in ${elapsed}s`)
console.table({
  ordersFetched: data.ordersFetched ?? data.summary?.ordersFetched ?? '?',
  ordersUpserted: data.ordersUpserted ?? data.summary?.ordersUpserted ?? '?',
  ordersFailed: data.ordersFailed ?? data.summary?.ordersFailed ?? '?',
})
