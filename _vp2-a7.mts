import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE='cmokmy3a40078pm0p1fvnu523', ACC='cmr4aaqb00025nz016k18rup9'
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const t0=Date.now()
const b=(await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${ACC}`})).json() as any
console.log('eBay·IT read', Date.now()-t0, 'ms | phases', JSON.stringify(b.meta.phases))
console.log('parent (A6)      :', JSON.stringify(b.parent))
console.log('counts (units)   :', JSON.stringify(b.counts))
const normal=b.children.find((c:any)=>c.sku==='GALE-JACKET-BLACK-MEN-3XL')
console.log('\nNORMAL row', normal.sku)
console.log('  sharedAxisValues:', JSON.stringify(normal.sharedAxisValues))
console.log('  suspect         :', JSON.stringify(normal.axisValuesSuspect))
console.log('  Colore cell     :', JSON.stringify(normal.values.Colore))
const xxs=b.children.filter((c:any)=>c.sku.endsWith('-XXS'))
for(const c of xxs){
  console.log('\nCLOBBERED row', c.sku)
  console.log('  sharedAxisValues:', JSON.stringify(c.sharedAxisValues))
  console.log('  values.Taglia   :', JSON.stringify(c.values.Taglia))
  console.log('  suspect         :', JSON.stringify(c.axisValuesSuspect))
}
const amz=(await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=AMAZON&market=IT`})).json() as any
const ac=amz.children[0]
console.log('\nAMAZON·IT', ac.sku, 'Colore cell:', JSON.stringify(ac.values.Colore))
console.log('AMAZON parent:', JSON.stringify(amz.parent))
const de=(await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=EBAY&market=DE&accountId=${ACC}`})).json() as any
console.log('\neBay·DE', de.children[0].sku, 'Colore cell:', JSON.stringify(de.children[0].values.Colore))
await app.close(); process.exit(0)
