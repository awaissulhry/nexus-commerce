import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import routes from './apps/api/src/routes/product-studio.routes.js'
const db=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL!}}})
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const roots = await db.product.findMany({ where:{ parentId:null, deletedAt:null, sku:{ in:['GALE-JACKET','MISANO','AIREON','XRI01','3K-HP05-BH9I'] } }, select:{ id:true, sku:true, variationAxes:true, variationTheme:true } })
for (const r of roots) {
  const f=(await app.inject({method:'GET',url:`/products/${r.id}/studio/family?market=IT`})).json() as any
  if (f.error) { console.log(`${r.sku}: ${f.error} ${f.message??''}`); continue }
  console.log(`\n${r.sku}  (declared axes: ${JSON.stringify(r.variationAxes)})`)
  console.log(`  children ${f.children.length} | axes ${f.axes.map((a:any)=>`${a.key}[${a.values.length}] source=${a.source} storedKey=${a.storedKey}`).join(' , ')||'(none)'}`)
  console.log(`  coverage: combinations=${f.coverage.combinations} existing=${f.coverage.existing} missing=${f.coverage.missing.length} duplicates=${f.coverage.duplicates.length}`)
  console.log(`  childrenMissingAxisValues: ${f.coverage.childrenMissingAxisValues.length} of ${f.children.length}`)
  console.log(`  axisValueConflicts: ${f.coverage.axisValueConflicts.length}`)
  console.log(`  BAND WOULD READ: "${f.coverage.existing} of ${f.coverage.combinations} combinations exist · ${f.coverage.missing.length} missing"`)
}
await app.close(); await db.$disconnect(); process.exit(0)
