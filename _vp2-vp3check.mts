import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE='cmokmy3a40078pm0p1fvnu523'
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const f=(await app.inject({method:'GET',url:`/products/${GALE}/studio/family?market=IT`})).json() as any
console.log('axes[].values codes:')
for(const a of f.axes) console.log(' ', a.key, '=', JSON.stringify(a.values.map((v:any)=>v.code)))
console.log('\nThe two XXS children, verbatim from /studio/family:')
for(const c of f.children.filter((c:any)=>c.sku.endsWith('-XXS')))
  console.log(' ', c.sku, 'axisValues =', JSON.stringify(c.axisValues))
console.log('\ncoverage:', JSON.stringify({combinations:f.coverage.combinations, existing:f.coverage.existing,
  missing:f.coverage.missing, duplicates:f.coverage.duplicates,
  childrenMissingAxisValues:f.coverage.childrenMissingAxisValues, conflicts:f.coverage.axisValueConflicts.length}))
console.log('\nchildren with an EMPTY Taglia:', f.children.filter((c:any)=>!c.axisValues.Taglia).map((c:any)=>c.sku))
console.log('children with an EMPTY Colore:', f.children.filter((c:any)=>!c.axisValues.Colore).map((c:any)=>c.sku))
await app.close(); process.exit(0)
