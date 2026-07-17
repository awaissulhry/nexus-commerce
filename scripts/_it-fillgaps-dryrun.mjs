// READ-ONLY DRY-RUN: fill-gaps-only merge preview for IT. Compares current
// flat-file rows (snapshot-overlaid) vs a live Amazon pull, and reports every
// field that WOULD be filled (current empty + Amazon has a value). Writes a
// detailed diff file + prints a summary. NO DB writes.
import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs'
const here = path.dirname(fileURLToPath(import.meta.url))
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nz = (v) => v != null && String(v).trim() !== ''
const bulletsOf = (r) => [r.bullet_point, r.bullet_point_1, r.bullet_point_2, r.bullet_point_3, r.bullet_point_4, r.bullet_point_5].filter(nz)

// 1. current rows
const { rows: cur } = await (await fetch(`${API}/api/amazon/flat-file/rows?marketplace=IT`)).json()
const curBySku = new Map(cur.map(r => [r.item_sku, r]))
// group SKUs by product_type
const byType = new Map()
for (const r of cur) { const t = String(r.product_type ?? '').toUpperCase() || 'UNKNOWN'; if (!byType.has(t)) byType.set(t, []); byType.get(t).push(r.item_sku) }

// 2. pull each type from Amazon
const pulled = new Map()
for (const [pt, skus] of byType) {
  process.stdout.write(`  pulling ${pt} (${skus.length})… `)
  const s = await fetch(`${API}/api/amazon/flat-file/pull-preview/start`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ marketplace:'IT', productType: pt, skus }) })
  const { jobId, error } = await s.json()
  if (!jobId) { console.log('start failed', error); continue }
  let job; for (let i=0;i<90;i++){ await sleep(2000); job=await(await fetch(`${API}/api/amazon/flat-file/pull-preview/status/${jobId}`)).json(); if((job.status??job.state)==='done')break }
  for (const r of job.rows ?? []) pulled.set(r.item_sku, r)
  console.log(`got ${(job.rows??[]).length}`)
}

// 3. compute fills
const FIELDS = [
  { key:'image',  cur:(r)=>r.main_product_image_locator, amz:(r)=>r.main_product_image_locator },
  { key:'brand',  cur:(r)=>r.brand, amz:(r)=>r.brand },
  { key:'desc',   cur:(r)=>r.product_description, amz:(r)=>r.product_description },
  { key:'asin',   cur:(r)=>r.external_product_id, amz:(r)=>r.external_product_id || r._asin },
]
const diffLines = []
const perFamily = new Map()
const totals = { image:0, brand:0, desc:0, asin:0, bullets:0 }
for (const [sku, c] of curBySku) {
  const a = pulled.get(sku); if (!a) continue
  const famKey = String(c.parentage_level??'').toLowerCase()==='parent' ? sku : (c.parent_sku || sku)
  const fills = []
  for (const f of FIELDS) { if (!nz(f.cur(c)) && nz(f.amz(a))) { fills.push(f.key); totals[f.key]++ } }
  if (bulletsOf(c).length === 0 && bulletsOf(a).length > 0) { fills.push(`bullets(+${bulletsOf(a).length})`); totals.bullets++ }
  if (fills.length) {
    if (!perFamily.has(famKey)) perFamily.set(famKey, [])
    perFamily.get(famKey).push({ sku, fills })
    diffLines.push(`${famKey}\t${sku}\t${fills.join(',')}`)
  }
}

console.log(`\n=== FILL-GAPS DRY-RUN (IT) — rows compared: ${curBySku.size}, pulled: ${pulled.size} ===`)
console.log('FIELD FILL TOTALS:', JSON.stringify(totals))
console.log('\nPer-family (rows that would get ≥1 field filled):')
for (const [fam, list] of [...perFamily.entries()].sort()) {
  const byField = {}; for (const x of list) for (const f of x.fills) { const k=f.split('(')[0]; byField[k]=(byField[k]||0)+1 }
  console.log(`  ${fam.padEnd(32)} rows=${String(list.length).padStart(2)}  ${JSON.stringify(byField)}`)
}
const outFile = path.join(here, `_it-fillgaps-diff.tsv`)
fs.writeFileSync(outFile, 'family\tsku\tfields_to_fill\n' + diffLines.join('\n'))
console.log(`\nFull per-row diff: ${outFile}`)
