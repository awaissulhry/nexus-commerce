import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import routes from './apps/api/src/routes/product-studio.routes.js'
const db=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL!}}})
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
for (const sku of ['AIREON','GALE-JACKET','3K-HP05-BH9I']) {
  const r = await db.product.findFirst({ where:{ sku, parentId:null, deletedAt:null }, select:{ id:true } })
  const f=(await app.inject({method:'GET',url:`/products/${r!.id}/studio/family?market=IT`})).json() as any
  const c=f.coverage
  console.log(`${sku}: children=${f.children.length} axes=${f.axes.length} valuesPerAxis=${JSON.stringify(f.axes.map((a:any)=>a.values.length))}`)
  console.log(`   THE PAIR IN ONE PAYLOAD -> missing: ${c.missing.length}   childrenMissingAxisValues: ${c.childrenMissingAxisValues.length}`)
  console.log(`   combinations: ${c.combinations}  existing: ${c.existing}  (both 0 on a ${f.children.length}-child family?)`)
}
await app.close(); await db.$disconnect(); process.exit(0)
