/**
 * One-time 12-month eBay financial events backfill.
 * Processes in 30-day windows via POST /api/ebay/financials/sync.
 * Run AFTER ebay orders have been synced (ebay-orders-sync cron running).
 *
 * Usage:
 *   NEXUS_API_URL=https://nexusapi-production-b7bb.up.railway.app \
 *   node scripts/backfill-ebay-financials-12m.mjs
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
const windows = []
let cursor = new Date(earliest)
while (cursor < now) {
  const end = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000, now.getTime()))
  windows.push({ start: new Date(cursor), end })
  cursor = end
}

console.log(`[ebay-fin-backfill] ${windows.length} windows · ${BACKEND}`)
let totalCreated = 0, totalFetched = 0

for (let i = 0; i < windows.length; i++) {
  const { start, end } = windows[i]
  process.stdout.write(`  Window ${i + 1}/${windows.length} ${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)} ... `)
  const res = await fetch(`${BACKEND}/api/ebay/financials/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: start.toISOString(), end: end.toISOString() }),
  }).catch(e => { console.error('\nError:', e.message); process.exit(1) })

  if (!res.ok) { console.error(`\nHTTP ${res.status}: ${await res.text().catch(() => '?')}`); process.exit(1) }
  const d = await res.json()
  totalCreated += d.txCreated ?? 0
  totalFetched += d.txFetched ?? 0
  console.log(`fetched=${d.txFetched ?? 0} created=${d.txCreated ?? 0} ms=${d.durationMs ?? 0}`)
  if (i < windows.length - 1) await sleep(1000)
}

console.log(`\n[ebay-fin-backfill] Done · total fetched=${totalFetched} created=${totalCreated}`)
