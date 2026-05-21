#!/usr/bin/env node
/**
 * OX.0 — repair Amazon orders that were ingested at €0.00 but should
 * have a real price (status NOT IN PENDING, CANCELLED). Calls SP-API
 * getOrder per stale row via POST /api/amazon/orders/backfill-zero-totals.
 *
 * Usage:
 *   NEXUS_API_URL=http://localhost:3001 \
 *   node scripts/backfill-amazon-zero-totals.mjs
 *
 * Optional:
 *   LIMIT=50 node scripts/backfill-amazon-zero-totals.mjs
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const BACKEND = process.env.NEXUS_API_URL ?? 'http://localhost:3001'
const LIMIT = parseInt(process.env.LIMIT ?? '100', 10)

console.log(`[backfill-zero-totals] POST ${BACKEND}/api/amazon/orders/backfill-zero-totals (limit=${LIMIT})`)

const start = Date.now()
const res = await fetch(`${BACKEND}/api/amazon/orders/backfill-zero-totals`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ limit: LIMIT }),
}).catch((err) => {
  console.error('Network error:', err.message)
  process.exit(1)
})

if (!res.ok) {
  const text = await res.text().catch(() => '(no body)')
  console.error(`[backfill-zero-totals] HTTP ${res.status}: ${text}`)
  process.exit(1)
}

const data = await res.json()
const elapsed = Math.round((Date.now() - start) / 1000)

console.log('[backfill-zero-totals] done in', elapsed, 'sec')
console.log(JSON.stringify(data, null, 2))
