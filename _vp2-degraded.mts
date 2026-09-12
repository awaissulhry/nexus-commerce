import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE='cmokmy3a40078pm0p1fvnu523'
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
// A coordinate whose channel sheet is expected to FAIL, vs one that succeeds, vs one that is genuinely freeform.
for (const [ch,mp,why] of [['EBAY','IT','sheet succeeds, 3 options'],['ETSY','GLOBAL','may have no schema'],['SHOPIFY','GLOBAL','freeform by design'],['AMAZON','PL','likely not configured']]) {
  const r=await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=${ch}&market=${mp}`})
  const b=r.json() as any
  if (b.error) { console.log(`${ch}/${mp}  -> ${r.statusCode} ${b.error}  (${why})`); continue }
  console.log(`${ch}/${mp}  -> 200  (${why})`)
  console.log(`   targetOptions: ${b.targetOptions.length}  freeform: ${b.freeform}  limits.axes: ${b.limits.axes}  sheetPhase: ${b.meta.phases?.sheet}ms`)
  console.log(`   counts: ${JSON.stringify(b.counts)}`)
  const c=b.children?.[0]
  if (c) console.log(`   child[0] readiness: ${JSON.stringify(c.readiness)}  Colore.source: ${c.values?.Colore?.source}`)
}
await app.close(); process.exit(0)
