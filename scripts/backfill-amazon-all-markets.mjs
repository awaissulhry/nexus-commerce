#!/usr/bin/env node
/**
 * MS.2 — one-shot catch-up backfill across all EU Amazon marketplaces.
 *
 * Why: before MS.1, the cron only swept a single marketplace (IT). So
 * orders from DE / FR / ES / UK / NL / SE / PL / BE / IE / TR that
 * arrived between manual sweeps were invisible to us. This script
 * pulls them in one go.
 *
 * Usage:
 *   NEXUS_API_URL=https://nexusapi-production-b7bb.up.railway.app \
 *     node scripts/backfill-amazon-all-markets.mjs
 *
 * Optional:
 *   DAYS_BACK=30        — how far back to scan (default 30)
 *   MARKETPLACES=IT,DE  — restrict to specific codes (default: all EU 11)
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const BACKEND = process.env.NEXUS_API_URL ?? 'http://localhost:3001'
const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? '30', 10)
const CODES = (process.env.MARKETPLACES ?? 'IT,DE,FR,ES,UK,NL,SE,PL,BE,IE,TR')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

console.log(`[backfill-all-markets] POST ${BACKEND}/api/amazon/orders/sync`)
console.log(`  daysBack=${DAYS_BACK}  marketplaces=${CODES.join(',')}`)

const start = Date.now()
const res = await fetch(`${BACKEND}/api/amazon/orders/sync`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    daysBack: DAYS_BACK,
    marketplaceCodes: CODES,
  }),
}).catch((err) => {
  console.error('Network error:', err.message)
  process.exit(1)
})

if (!res.ok) {
  const text = await res.text().catch(() => '(no body)')
  console.error(`[backfill-all-markets] HTTP ${res.status}: ${text}`)
  process.exit(1)
}

const data = await res.json()
const elapsed = Math.round((Date.now() - start) / 1000)
console.log(`[backfill-all-markets] done in ${elapsed}s`)
console.log(JSON.stringify(data, null, 2))
