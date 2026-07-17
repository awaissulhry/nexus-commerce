// READ-ONLY: trigger flat-file pull-preview (getListingsItem, no DB writes) for
// AIREON jacket + pant samples and report Amazon's parentage per row.
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(productType, skus) {
  const start = await fetch(`${API}/api/amazon/flat-file/pull-preview/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketplace: 'IT', productType, skus }),
  })
  const { jobId, error } = await start.json()
  if (!jobId) { console.log(`  start failed: ${error ?? JSON.stringify(await start.text())}`); return }
  let job
  for (let i = 0; i < 30; i++) {
    await sleep(1500)
    const st = await fetch(`${API}/api/amazon/flat-file/pull-preview/status/${jobId}`)
    job = await st.json()
    if (job.status === 'done' || job.status === 'error' || job.done || job.state === 'done') break
  }
  console.log(`  job status=${job.status ?? job.state}  rows=${(job.rows ?? []).length}  error=${job.error ?? '—'}`)
  for (const r of job.rows ?? []) {
    const parentish = ['_parentAsin', 'parent_asin', '_asin', 'external_product_id']
    const extra = parentish.map((k) => r[k] ? `${k}=${r[k]}` : '').filter(Boolean).join(' ')
    console.log(`   ${r.item_sku}  parentage=${r.parentage_level ?? '∅'}  parent_sku=${r.parent_sku ?? '∅'}  type=${r.product_type ?? '∅'}  ${extra}`)
  }
}

console.log('=== AIREON JACKET (OUTERWEAR) ===')
await run('OUTERWEAR', ['XAVIA-AIREON-GIACCA-DA', 'AIREON-JACKET-NERO-NEO-MEN-M', 'AIREON-JACKET-CREMA-E-VINO-MEN-M'])
console.log('\n=== AIREON PANT (PANTS) ===')
await run('PANTS', ['XAVIA-AIREON-PANTALONI-MOTO', 'AIREON-PANT-NERO-NEO-MEN-M', 'AIREON-PANT-CREMA-E-VINO-MEN-M'])
