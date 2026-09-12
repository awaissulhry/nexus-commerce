import Fastify from 'fastify'; import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import routes from './apps/api/src/routes/product-studio.routes.js'
const db=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL!}}})
const app=Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const id = async (sku:string)=> (await db.product.findFirst({where:{sku,parentId:null,deletedAt:null},select:{id:true}}))!.id
const GALE=await id('GALE-JACKET')

console.log('=== coverage: nullable + state (was "0 of 0 · 0 missing" on 40 children) ===')
for (const sku of ['GALE-JACKET','AIREON','3K-HP05-BH9I']) {
  const f=(await app.inject({method:'GET',url:`/products/${await id(sku)}/studio/family?market=IT`})).json() as any
  const c=f.coverage
  console.log(` ${sku.padEnd(14)} state=${c.state.padEnd(9)} combinations=${JSON.stringify(c.combinations)} existing=${JSON.stringify(c.existing)} missing=${c.missing===null?'null':c.missing.length} childrenMissingAxisValues=${c.childrenMissingAxisValues.length} dup=${c.duplicates.length}`)
}
console.log('\n=== readiness vs completeness: two names, two measurements ===')
for (const [ch,mp] of [['EBAY','IT'],['AMAZON','IT'],['AMAZON','PL'],['ETSY','GLOBAL']]) {
  const b=(await app.inject({method:'GET',url:`/products/${GALE}/studio/projection?channel=${ch}&market=${mp}`})).json() as any
  const c=b.children?.[0]
  console.log(` ${ch}/${mp}`.padEnd(16), 'readiness=', JSON.stringify(c?.readiness), ' completeness=', JSON.stringify(c?.completeness))
  console.log(''.padEnd(16), `targetOptions=${b.targetOptions.length} state=${b.targetOptionsState} schemaMissing=${JSON.stringify(b.schemaMissing)}`)
}
await app.close(); await db.$disconnect(); process.exit(0)
