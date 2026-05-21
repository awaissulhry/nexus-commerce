/**
 * Multi-marketplace Amazon order backfill (M2).
 *
 * Calls POST /api/amazon/orders/sync with daysBack=365 against the
 * specified marketplaces. Server fans out one SP-API call per
 * marketplace sequentially (to respect per-account rate limits) and
 * returns a per-marketplace results array.
 *
 * Marketplace selection precedence:
 *   1. --marketplaces=DE,FR,ES,NL  (2-letter codes, comma-separated)
 *   2. MARKETPLACES=DE,FR env var
 *   3. (no flag) → all `isParticipating=true` markets from M1 refresh
 *
 * Usage:
 *   # Backfill DE only
 *   NEXUS_API_URL=https://nexusapi-production-b7bb.up.railway.app \
 *   node scripts/backfill-amazon-orders-12m.mjs --marketplaces=DE
 *
 *   # Backfill all EU EUR markets
 *   node scripts/backfill-amazon-orders-12m.mjs --marketplaces=DE,FR,ES,NL
 *
 *   # Backfill every participating market (post-M1)
 *   node scripts/backfill-amazon-orders-12m.mjs
 *
 *   # Custom window
 *   DAYS_BACK=730 node scripts/backfill-amazon-orders-12m.mjs --marketplaces=IT
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const BACKEND = process.env.NEXUS_API_URL ?? 'http://localhost:3001'
const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? '365', 10)

// Parse --marketplaces=XX,YY from argv (or MARKETPLACES env fallback).
function parseMarketplaceFlag() {
  const arg = process.argv.find((a) => a.startsWith('--marketplaces='))
  if (arg) return arg.split('=')[1].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (process.env.MARKETPLACES) {
    return process.env.MARKETPLACES.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  }
  return null
}

const codes = parseMarketplaceFlag()
const targetLabel = codes ? codes.join(', ') : 'ALL PARTICIPATING'

console.log(`[backfill] Syncing Amazon orders — ${DAYS_BACK} days — markets: ${targetLabel}`)
console.log(`[backfill] Endpoint: ${BACKEND}/api/amazon/orders/sync`)

const body = { daysBack: DAYS_BACK }
if (codes) body.marketplaceCodes = codes

const start = Date.now()
const res = await fetch(`${BACKEND}/api/amazon/orders/sync`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).catch((err) => {
  console.error('Network error:', err.message)
  process.exit(1)
})

if (!res.ok) {
  const text = await res.text().catch(() => '(no body)')
  console.error(`[backfill] HTTP ${res.status}: ${text}`)
  process.exit(1)
}

const data = await res.json()
const elapsed = Math.round((Date.now() - start) / 1000)
console.log(`[backfill] Done in ${elapsed}s`)
console.log()

// M2: response is either flat single-market or { results: [...] } multi-market.
if (Array.isArray(data.results)) {
  console.log(`[backfill] Multi-marketplace fan-out (${data.marketplaceCount} markets):`)
  const table = data.results.map((r) => ({
    marketplace: r.marketplaceCode,
    fetched: r.summary?.ordersFetched ?? '—',
    upserted: r.summary?.ordersUpserted ?? '—',
    failed: r.summary?.ordersFailed ?? '—',
    error: r.error ?? '',
  }))
  console.table(table)
  if (!data.success) {
    console.error('[backfill] Some markets failed; see results above.')
    process.exit(1)
  }
} else {
  // Single-market legacy shape.
  console.table({
    ordersFetched: data.ordersFetched ?? '?',
    ordersUpserted: data.ordersUpserted ?? '?',
    ordersFailed: data.ordersFailed ?? '?',
  })
}
