import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const API='https://nexusapi-production-b7bb.up.railway.app'

const fba = await prisma.product.findUnique({ where:{sku:'GALE-JACKET'}, select:{id:true} })
const kids = await prisma.product.findMany({ where:{parentId:fba.id, deletedAt:null}, select:{sku:true, fulfillmentMethod:true} })
const fba_n = kids.filter(k=>!/_FBM$/i.test(k.sku)).length
const fbm_n = kids.filter(k=>/_FBM$/i.test(k.sku)).length
console.log(`GALE-JACKET children now: ${kids.length}  (FBA-named=${fba_n}, FBM-named=${fbm_n})`)

const fbm = await prisma.product.findUnique({ where:{sku:'GALE-JACKET-FBM'}, select:{id:true, deletedAt:true, _count:{select:{channelListings:true,children:true}}} })
console.log(`GALE-JACKET-FBM parent: deletedAt=${fbm.deletedAt?.toISOString().slice(0,10)}  listings=${fbm._count.channelListings}  children=${fbm._count.children}`)

// what references GALE-JACKET-FBM (why hard-delete blocked)?
for (const [table, where] of [
  ['orderItem', { productId: fbm.id }],
  ['channelStockEvent', { productId: fbm.id }],
  ['priceChangeEvent', { productId: fbm.id }],
  ['repricingRule', { productId: fbm.id }],
]) {
  try { const c = await prisma[table].count({ where }); if(c>0) console.log(`  blocked-by ${table}: ${c} rows`) } catch(e){}
}

// flat-file: GALE families visible
const { rows } = await (await fetch(`${API}/api/amazon/flat-file/rows?marketplace=IT`)).json()
const pl=(r)=>String(r.parentage_level??'').toLowerCase()
const galeFams = new Set()
for (const r of rows){ const key = pl(r)==='parent'?r.item_sku:r.parent_sku; if(/GALE/i.test(String(key))) galeFams.add(key) }
console.log(`\nFlat-file GALE families visible: [${[...galeFams].join(', ')}]`)
const galeKids = rows.filter(r=>String(r.parent_sku)==='GALE-JACKET').length
console.log(`GALE-JACKET children in flat file: ${galeKids}`)
await prisma.$disconnect()
