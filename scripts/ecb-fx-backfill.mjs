#!/usr/bin/env node
// Phase 6.A — ECB FX rate historical backfill.
//
// Pulls historical EUR → {active marketplace currencies} from
// frankfurter.app (free, ECB-backed, no auth) and upserts into FxRate.
// Required for Phase 6 financial backfill to compute EUR-equivalent
// values for non-EUR orders (GBP/USD/SEK/PLN per Marketplace.currency).
//
// Why standalone (raw pg + raw fetch) instead of importing fx-rate.service:
// importing apps/api services triggers full server bootstrap that hangs
// at module load. Same pattern as scripts/first-backfill.mjs.
//
// Idempotent — upsert on (fromCurrency, toCurrency, asOf) unique constraint.
// Manual-source rows (source='manual') are preserved (we only write
// source='frankfurter').
//
// frankfurter publishes Mon-Fri (ECB business days). Weekend/holiday
// requests return the previous business day's rate; we still upsert
// using the requested date so lookups for weekend orders resolve.
//
// Usage:
//   node scripts/ecb-fx-backfill.mjs --from 2024-05-20 --to 2026-05-20 [--dry-run]

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

function parseArgs(argv) {
  const out = { dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (!val || val.startsWith('--')) { out[key] = true; continue }
      out[key] = val
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv)
const fromStr = args.from
const toStr = args.to || new Date().toISOString().slice(0, 10)

if (!fromStr || !/^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
  console.error('Usage: --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run]')
  process.exit(2)
}

const from = new Date(`${fromStr}T00:00:00Z`)
const to = new Date(`${toStr}T00:00:00Z`)
if (to < from) { console.error('--to must be >= --from'); process.exit(2) }

const MASTER = process.env.NEXUS_MASTER_CURRENCY || 'EUR'

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Discover target currencies (active marketplaces, excluding master)
const targetsRes = await c.query(`
  SELECT DISTINCT currency FROM "Marketplace"
  WHERE "isActive" = true AND currency != $1
  ORDER BY currency
`, [MASTER])
const targets = targetsRes.rows.map(r => r.currency)
if (targets.length === 0) {
  console.log(`No non-${MASTER} active marketplaces. Nothing to backfill.`)
  await c.end()
  process.exit(0)
}

console.log(`\n━━━ ECB FX backfill: ${MASTER} → {${targets.join(', ')}} ${'━'.repeat(15)}`)
console.log(`  window:   ${fromStr} → ${toStr}`)
console.log(`  mode:     ${args.dryRun ? 'DRY-RUN' : 'LIVE'}`)

// Enumerate business days. Frankfurter accepts any date; weekends/holidays
// return the previous business day's rate. We still query+upsert every day
// so weekend orders resolve correctly via the exact-date lookup.
const days = []
const cursor = new Date(from)
while (cursor <= to) {
  days.push(cursor.toISOString().slice(0, 10))
  cursor.setUTCDate(cursor.getUTCDate() + 1)
}
console.log(`  days:     ${days.length}`)

const summary = { fetched: 0, upserted: 0, errors: 0, skipped: 0 }

// frankfurter has no documented rate limit, but be polite — small pause
// between requests. ~150ms × 730 days ≈ 110s for a 2-year backfill.
const SLEEP_MS = 150

for (let i = 0; i < days.length; i++) {
  const day = days[i]
  const url = `https://api.frankfurter.app/${day}?from=${MASTER}&to=${targets.join(',')}`
  try {
    const r = await fetch(url)
    if (!r.ok) {
      const text = await r.text()
      console.log(`  [${i+1}/${days.length}] ${day} — HTTP ${r.status}: ${text.slice(0, 100)}`)
      summary.errors++
      continue
    }
    const data = await r.json()
    const rates = data?.rates || {}
    summary.fetched++

    if (args.dryRun) {
      if (i % 50 === 0 || i === days.length - 1) {
        process.stdout.write(`  [${i+1}/${days.length}] ${day} — ${Object.keys(rates).map(k => `${k}=${rates[k].toFixed(4)}`).join(' ')}\n`)
      }
    } else {
      const asOfDate = new Date(`${day}T00:00:00Z`)
      for (const [ccy, rate] of Object.entries(rates)) {
        if (!Number.isFinite(rate) || rate <= 0) continue
        await c.query(`
          INSERT INTO "FxRate" (id, "fromCurrency", "toCurrency", rate, "asOf", source, "createdAt")
          VALUES ($1, $2, $3, $4, $5, 'frankfurter', NOW())
          ON CONFLICT ("fromCurrency", "toCurrency", "asOf")
          DO UPDATE SET rate = EXCLUDED.rate
          WHERE "FxRate".source != 'manual'
        `, [
          `fx_${MASTER}_${ccy}_${day}`.replace(/-/g, ''),
          MASTER,
          ccy,
          Number(rate).toFixed(8),
          asOfDate,
        ])
        summary.upserted++
      }
      if (i % 50 === 0 || i === days.length - 1) {
        process.stdout.write(`  [${i+1}/${days.length}] ${day} — upserted ${Object.keys(rates).length} pairs\n`)
      }
    }

    if (SLEEP_MS > 0 && i < days.length - 1) {
      await new Promise(r => setTimeout(r, SLEEP_MS))
    }
  } catch (e) {
    console.log(`  [${i+1}/${days.length}] ${day} — ERROR: ${e.message}`)
    summary.errors++
  }
}

await c.end()

console.log(`\n━━━ summary ${'━'.repeat(50)}`)
console.log(`  days fetched:  ${summary.fetched}/${days.length}`)
console.log(`  pairs written: ${summary.upserted}${args.dryRun ? ' (dry-run, not written)' : ''}`)
console.log(`  errors:        ${summary.errors}`)
if (summary.errors > 0) process.exit(1)
