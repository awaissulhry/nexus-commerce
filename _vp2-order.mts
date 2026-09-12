import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE='cmokmy3a40078pm0p1fvnu523', ACC='cmr4aaqb00025nz016k18rup9'
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const f=(await app.inject({method:'GET',url:`/products/${GALE}/studio/family?market=IT`})).json() as any
for(const a of f.axes){
  console.log(a.key)
  console.log('  values (ordered):', JSON.stringify(a.values.map((v:any)=>`${v.code}×${v.count}`)))
  console.log('  valueOrder      :', JSON.stringify(a.valueOrder))
}
console.log('\ncoverage unchanged:', JSON.stringify({combinations:f.coverage.combinations, existing:f.coverage.existing, missing:f.coverage.missing.length, duplicates:f.coverage.duplicates.length}))
const p=(await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${ACC}`})).json() as any
console.log('\nprojection parent (nested now):', JSON.stringify(p.parent))
console.log('child listing shape           :', JSON.stringify(p.children[0].listing))
await app.close(); process.exit(0)
