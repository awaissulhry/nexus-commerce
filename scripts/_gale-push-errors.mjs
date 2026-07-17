// Push Gale + show only errors with full messages
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const rowsRes = await fetch(`${API}/api/ebay/flat-file/rows`)
const { rows: allRows } = await rowsRes.json()
const galeRows = allRows.filter(r =>
  String(r.sku ?? '').toUpperCase().startsWith('GALE-JACKET') &&
  !String(r.sku ?? '').toUpperCase().includes('FBM')
)
console.log(`Pushing ${galeRows.length} rows…`)
const pushRes = await fetch(`${API}/api/ebay/flat-file/push`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rows: galeRows, marketplace: 'IT', mode: 'api' }),
})
const data = await pushRes.json().catch(() => ({}))
const results = data.results ?? []
const errors = results.filter(r => r.status === 'ERROR')
const pushed = results.filter(r => r.status === 'PUSHED')
console.log(`pushed=${pushed.length}  errors=${errors.length}`)
if (errors.length) {
  console.log('\n── ERRORS ──')
  for (const r of errors) console.log(`  ✗ ${r.sku}\n      ${r.message}`)
}
