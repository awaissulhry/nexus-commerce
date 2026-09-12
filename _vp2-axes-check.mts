import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE='cmokmy3a40078pm0p1fvnu523', ACC='cmr4aaqb00025nz016k18rup9'
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const b=(await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${ACC}`})).json() as any
for(const a of b.axes){
  console.log(a.key, '| hasSuspectRows =', a.hasSuspectRows)
  for(const v of a.values) console.log('   ', v.code.padEnd(6), 'count', v.count, v.suspectRows ? `(${v.suspectRows} SUSPECT)` : '')
}
const t=Date.now(); const amz=(await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=AMAZON&market=IT`})).json() as any
console.log('\nAmazon·IT read', Date.now()-t, 'ms | phases', JSON.stringify(amz.meta.phases), '| counts', JSON.stringify(amz.counts))
await app.close(); process.exit(0)
