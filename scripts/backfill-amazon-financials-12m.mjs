/**
 * One-time 12-month Amazon financial events backfill.
 *
 * Processes 12 months in 30-day windows to stay within SP-API rate
 * limits (listFinancialEvents: 0.5 req/s with pagination sleep built in).
 *
 * Run AFTER backfill-amazon-orders-12m.mjs — financial events can only
 * be linked to orders already in Nexus.
 *
 * Usage:
 *   NEXUS_API_URL=https://nexusapi-production-b7bb.up.railway.app \
 *   node scripts/backfill-amazon-financials-12m.mjs
 *
 * Optional env:
 *   MONTHS_BACK=12   (default 12)
 *   CHUNK_DAYS=30    (default 30)
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const BACKEND = process.env.NEXUS_API_URL ?? 'http://localhost:3001'
const MONTHS_BACK = parseInt(process.env.MONTHS_BACK ?? '12', 10)
const CHUNK_DAYS = parseInt(process.env.CHUNK_DAYS ?? '30', 10)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const now = new Date()
const earliest = new Date(now.getTime() - MONTHS_BACK * 30 * 24 * 60 * 60 * 1000)

// Build list of [start, end] windows from oldest to newest
const windows = []
let cursor = new Date(earliest)
while (cursor < now) {
  const windowEnd = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000, now.getTime()))
  windows.push({ start: new Date(cursor), end: windowEnd })
  cursor = windowEnd
}

console.log(`[fin-backfill] ${windows.length} windows of ${CHUNK_DAYS} days over ${MONTHS_BACK} months`)
console.log(`[fin-backfill] Backend: ${BACKEND}`)

let totalCreated = 0
let totalSkipped = 0
let totalOrderEvents = 0

for (let i = 0; i < windows.length; i++) {
  const { start, end } = windows[i]
  const label = `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`
  process.stdout.write(`[fin-backfill] Window ${i + 1}/${windows.length} ${label} ... `)

  const res = await fetch(`${BACKEND}/api/amazon/financials/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: start.toISOString(), end: end.toISOString() }),
  }).catch(err => { console.error('\nNetwork error:', err.message); process.exit(1) })

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    console.error(`\n[fin-backfill] HTTP ${res.status}: ${text}`)
    process.exit(1)
  }

  const data = await res.json()
  totalCreated += data.txCreated ?? 0
  totalSkipped += data.txSkipped ?? 0
  totalOrderEvents += data.orderEventsFetched ?? 0

  console.log(`created=${data.txCreated ?? 0} skipped=${data.txSkipped ?? 0} matched=${data.ordersMatched ?? 0} ms=${data.durationMs ?? 0}`)

  // Respect rate limit between windows — financial events endpoint is slow
  if (i < windows.length - 1) await sleep(3000)
}

console.log('\n[fin-backfill] Complete')
console.table({ totalOrderEvents, totalCreated, totalSkipped })
