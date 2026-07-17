const API = 'https://nexusapi-production-b7bb.up.railway.app'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const start = await fetch(`${API}/api/amazon/flat-file/pull-preview/start`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ marketplace: 'IT', productType: 'GLOVES',
    skus: ['1J-EYE5-Y0TW','xriser-bla-l','xriser-bla-m','xriser-bla-s','xriser-bla-xl','xriser-bla-xxl'] }),
})
const { jobId, error } = await start.json()
if (!jobId) { console.log('start failed', error); process.exit(1) }
let job
for (let i=0;i<30;i++){ await sleep(1500); job = await (await fetch(`${API}/api/amazon/flat-file/pull-preview/status/${jobId}`)).json(); if ((job.status??job.state)==='done'||(job.status??job.state)==='error') break }
console.log(`status=${job.status??job.state} rows=${(job.rows??[]).length} pulled=${job.pulled} skipped=${job.skipped} failed=${job.failed}`)
if (job.errors?.length) console.log('errors:', JSON.stringify(job.errors).slice(0,300))
for (const r of job.rows ?? []) {
  console.log(`  ${r.item_sku}  asin=${r._asin??'∅'}  title="${String(r.item_name??'').slice(0,55)}"  color=${r.color||'∅'}  size=${r.size||r.size_name||r.apparel_size||'∅'}  theme=${r.variation_theme||'∅'}`)
}
