// Push Gale Jacket family to eBay IT via the live API and print per-SKU results.
// Uses the prod Railway API so the full server-side logic (brand inject, image fallback, etc.) runs.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'https://nexusapi-production-b7bb.up.railway.app'

// ── 1. Fetch Gale Jacket rows ───────────────────────────────────────────────
console.log('Fetching eBay flat-file rows for Gale Jacket family…')
const rowsRes = await fetch(`${API}/api/ebay/flat-file/rows`, {
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
})
if (!rowsRes.ok) {
  console.error(`GET /rows failed: ${rowsRes.status}`, await rowsRes.text())
  process.exit(1)
}
const { rows: allRows } = await rowsRes.json()
const galeRows = allRows.filter(r => String(r.sku ?? '').toUpperCase().includes('GALE'))
console.log(`Found ${galeRows.length} Gale rows:`, galeRows.map(r => r.sku).join(', '))
if (galeRows.length === 0) { console.error('No Gale rows found — check family filter'); process.exit(1) }

// Log image fields for each row so we can see if images are populated
console.log('\n── Image fields per row ──')
for (const r of galeRows) {
  const imgs = [1,2,3,4,5,6].map(i => r[`image_${i}`]).filter(Boolean)
  console.log(`  ${String(r.sku).padEnd(35)} images: ${imgs.length > 0 ? imgs.map(u => u.slice(0,60)).join(', ') : '(none)'}`)
}

// ── 2. Push to eBay IT ──────────────────────────────────────────────────────
console.log('\nPushing to eBay IT…')
const pushRes = await fetch(`${API}/api/ebay/flat-file/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ rows: galeRows, marketplace: 'IT', mode: 'api' }),
})
const pushText = await pushRes.text()
let pushData
try { pushData = JSON.parse(pushText) } catch { pushData = pushText }

console.log(`\nPush HTTP ${pushRes.status}`)
if (Array.isArray(pushData)) {
  const errors   = pushData.filter(r => r.status === 'ERROR')
  const pushed   = pushData.filter(r => r.status === 'PUSHED')
  const other    = pushData.filter(r => r.status !== 'ERROR' && r.status !== 'PUSHED')
  console.log(`  PUSHED: ${pushed.length}   ERRORS: ${errors.length}   OTHER: ${other.length}`)
  if (pushed.length) {
    console.log('\n── PUSHED ──')
    for (const r of pushed) console.log(`  ✓ ${r.sku}${r.itemId ? `  listingId=${r.itemId}` : ''}`)
  }
  if (errors.length) {
    console.log('\n── ERRORS ──')
    for (const r of errors) console.log(`  ✗ ${r.sku}\n      ${r.message}`)
  }
  if (other.length) {
    console.log('\n── OTHER ──')
    for (const r of other) console.log(`  ? ${r.sku}  status=${r.status}  ${r.message}`)
  }
} else {
  console.log(JSON.stringify(pushData, null, 2))
}
