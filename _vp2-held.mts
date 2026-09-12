import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE='cmokmy3a40078pm0p1fvnu523', ACC='cmr4aaqb00025nz016k18rup9'
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
for (const mp of ['IT','DE','FR']) {
  const b=(await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=EBAY&market=${mp}&accountId=${ACC}`})).json() as any
  const c=b.children?.[0]
  if(!c){ console.log(`EBAY/${mp}: no children in payload`); continue }
  const v=c.values.Colore
  console.log(`EBAY/${mp}  ${c.sku}`)
  console.log('   write        :', JSON.stringify(v.write))
  console.log('   heldReason   :', JSON.stringify(v.writeBlockedReason))
  console.log('   sharedWrite  :', JSON.stringify(v.sharedWrite))
  console.log('   inherited    :', JSON.stringify({v:v.inheritedValue, r:v.inheritedValueUnknownReason}))
}
await app.close(); process.exit(0)
