import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE='cmokmy3a40078pm0p1fvnu523'
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const f=(await app.inject({method:'GET',url:`/products/${GALE}/studio/family?market=IT`})).json() as any
const run = async (pattern: string, label: string) => {
  const r=(await app.inject({method:'POST',url:`/products/${GALE}/studio/family/generate`,payload:{
    version:f.version, dryRun:true, skuPattern:pattern,
    axisValues:{Colore:['Nero','Giallo','Rosso'], Taglia:['XXS','M']}}})).json() as any
  console.log(`${label}\n  pattern: ${pattern}`)
  console.log('  warnings:', JSON.stringify(r.skuConventionWarnings))
  console.log('  first SKUs:', JSON.stringify(r.plan.slice(0,3).map((p:any)=>p.sku)))
}
await run('{parent}-{Colore.code}-MEN-{Taglia.code}', 'A. the canvas pattern (uses .code)')
await run('{parent}-{Colore}-MEN-{Taglia}', 'B. raw values, no .code — no convention claim to check')
console.log('\nPOSITIVE CONTROL — a value whose code DOES appear in sibling SKUs must NOT warn:')
const c=(await app.inject({method:'POST',url:`/products/${GALE}/studio/family/generate`,payload:{
  version:f.version, dryRun:true, skuPattern:'{parent}-{Taglia.code}', axisValues:{Colore:['Nero'],Taglia:['M','XL']}}})).json() as any
console.log('  Taglia M/XL warnings (expect none — SKUs contain -M and -XL):', JSON.stringify(c.skuConventionWarnings))
await app.close(); process.exit(0)
