// READ-ONLY: does a live Amazon pull return the content we're missing?
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function run(pt, skus) {
  const s = await fetch(`${API}/api/amazon/flat-file/pull-preview/start`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ marketplace:'IT', productType: pt, skus }) })
  const { jobId } = await s.json()
  let job; for (let i=0;i<30;i++){ await sleep(1500); job=await(await fetch(`${API}/api/amazon/flat-file/pull-preview/status/${jobId}`)).json(); if((job.status??job.state)==='done')break }
  for (const r of job.rows ?? []) {
    console.log(`  ${r.item_sku} [${r.parentage_level}]  img=${r.main_product_image_locator?'YES':'∅'}  bullets=${[r.bullet_point,r.bullet_point_1,r.bullet_point_2].filter(x=>x&&String(x).trim()).length}  desc=${r.product_description?('YES('+String(r.product_description).length+')'):'∅'}  brand=${r.brand||'∅'}  theme=${r.variation_theme||'∅'}`)
  }
}
console.log('=== GALE-JACKET sample (children missing img in DB) ===')
await run('OUTERWEAR', ['GALE-JACKET','GALE-JACKET-BLACK-MEN-M'])
console.log('=== REGAL sample (children missing desc in DB) ===')
await run('OUTERWEAR', ['REGAL-JACKET','REGAL-JACKET-M-BLACK-MEN'])
