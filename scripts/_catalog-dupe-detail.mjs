import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
// 3rd soft-deleted product (no listings)
const del = await prisma.product.findMany({ where:{ deletedAt:{not:null} }, select:{ sku:true, name:true, deletedAt:true, parentId:true, isParent:true, _count:{select:{channelListings:true,children:true}} } })
console.log('=== ALL soft-deleted products ===')
for(const p of del) console.log(`  ${p.sku}  deleted=${p.deletedAt.toISOString().slice(0,10)}  listings=${p._count.channelListings} children=${p._count.children} isParent=${p.isParent}`)

// GALE XXS/XS duplicate detail
console.log('\n=== GALE children with duplicated/suspect ASIN (XXS vs XS) ===')
const gale = await prisma.product.findMany({ where:{ sku:{ startsWith:'GALE-JACKET-', mode:'insensitive' }, deletedAt:null }, select:{ sku:true, amazonAsin:true, variantAttributes:true } })
// group by asin
const byAsin=new Map()
for(const g of gale){ if(!byAsin.has(g.amazonAsin))byAsin.set(g.amazonAsin,[]); byAsin.get(g.amazonAsin).push(g) }
for(const [asin,list] of byAsin) if(list.length>1){
  console.log(`  ASIN ${asin}:`)
  for(const g of list) console.log(`     ${g.sku}  variantAttributes=${JSON.stringify(g.variantAttributes)}`)
}
console.log(`\nGALE-JACKET(FBA) total children: ${gale.length}`)

// GALE-JACKET-FBM: do its children have AMAZON listings (potential dup Amazon offers)?
const fbm = await prisma.product.findUnique({ where:{ sku:'GALE-JACKET-FBM' }, select:{ id:true } })
const fbmKids = await prisma.product.findMany({ where:{ parentId: fbm.id }, select:{ id:true } })
const fbmAmz = await prisma.channelListing.count({ where:{ channel:'AMAZON', productId:{in:fbmKids.map(k=>k.id)} } })
const fbmEbay = await prisma.channelListing.count({ where:{ channel:'EBAY', productId:{in:fbmKids.map(k=>k.id)} } })
console.log(`\nGALE-JACKET-FBM: ${fbmKids.length} children — AMAZON listings=${fbmAmz}, EBAY listings=${fbmEbay}`)
await prisma.$disconnect()
