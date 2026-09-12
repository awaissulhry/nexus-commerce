import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE='cmokmy3a40078pm0p1fvnu523'
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const f=(await app.inject({method:'GET',url:`/products/${GALE}/studio/family?market=IT`})).json() as any
const r=(await app.inject({method:'POST',url:`/products/${GALE}/studio/family/generate`,payload:{
  version:f.version, dryRun:true, skuPattern:'{parent}-{Colore.code}-MEN-{Taglia.code}',
  axisValues:{Colore:['Nero','Giallo','Rosso'], Taglia:['XXS','M']}}})).json() as any
console.log('codes (server-stated, the §3.4 line):', JSON.stringify(r.codes))
console.log('first SKUs                           :', JSON.stringify(r.plan.slice(0,3).map((p:any)=>p.sku)))
const r2=(await app.inject({method:'POST',url:`/products/${GALE}/studio/family/generate`,payload:{
  version:f.version, dryRun:true, skuPattern:'{parent}-{Colore}-MEN-{Taglia}',
  axisValues:{Colore:['Nero'], Taglia:['XXS']}}})).json() as any
console.log('CONTROL, pattern with no .code token :', JSON.stringify(r2.codes), '(expect {})')
await app.close(); process.exit(0)
