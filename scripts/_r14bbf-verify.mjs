// TEMP — verify R1.4b-backfill re-rolls historical ProductProfitDaily with real fees.
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const url = process.env.DATABASE_URL?.replace('-pooler', '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ppd() {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  const r = await c.query(
    `SELECT date, count(*)::int n, sum("referralFeesCents")::bigint ref, sum("grossRevenueCents")::bigint rev
     FROM "ProductProfitDaily" WHERE date >= now() - interval '8 days' GROUP BY date ORDER BY date DESC`,
  )
  await c.end()
  return r.rows
}
const rate = (row) => {
  const ref = Number(row.ref) || 0, rev = Number(row.rev) || 0
  return rev > 0 ? ((ref / rev) * 100).toFixed(1) : '-'
}

// 1. poll deploy by triggering backfill (404 on old build, {started} on new)
let started = false
for (let i = 1; i <= 40; i++) {
  try {
    const r = await fetch(`${API}/api/amazon/economics/profit-backfill?days=90`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (r.status === 200 || r.status === 202) {
      const d = await r.json()
      if (d && d.started) {
        started = true
        console.log(`[deploy] LIVE after ${i} poll(s) — backfill started: ${JSON.stringify(d)}`)
        break
      }
    } else {
      console.log(`[deploy] poll ${i}: ${r.status}`)
    }
  } catch (e) {
    console.log(`[deploy] poll ${i}: ${e.message}`)
  }
  await sleep(10000)
}
if (!started) { console.log('NOT LIVE — abort'); process.exit(1) }

console.log('\n[before] recent ProductProfitDaily:')
for (const row of await ppd())
  console.log(`  ${row.date.toISOString().slice(0, 10)}: rate=${rate(row)}%  (ref €${(Number(row.ref) / 100).toFixed(2)})`)

// 2. watch historical rows fill in
for (let i = 1; i <= 18; i++) {
  await sleep(10000)
  const rows = await ppd()
  const withFees = rows.filter((r) => Number(r.ref) > 0).length
  console.log(`[backfill] +${i * 10}s → ${withFees}/${rows.length} recent days have real referral fees`)
  if (withFees >= rows.length - 1 && rows.length >= 5) {
    console.log('\n[after] recent ProductProfitDaily (historical corrected):')
    for (const row of rows)
      console.log(`  ${row.date.toISOString().slice(0, 10)}: rate=${rate(row)}%  (ref €${(Number(row.ref) / 100).toFixed(2)})`)
    break
  }
}
console.log('\nDONE')
