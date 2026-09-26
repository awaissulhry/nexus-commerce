// READ-ONLY: whole-catalog audit for extra/duplicate/orphaned products & listings.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

// the 14 real Amazon families (parent SKU -> ASIN), operator-provided
const AMZ_ASINS = new Set(['B0FXCDEDCA','B0FXCC827B','B0C3YRQPFT','B0FX749EA8','B0FX023BCD','B0FX521367','B0FXBC7417','B0FX908898','B0FX10086B','B0FXD0620C','B0DYXSQP18','B0FX8A5E82','B0FX5D1762','B0FX8D94BC'])

const all = await prisma.product.findMany({
  select: { id:true, sku:true, name:true, status:true, deletedAt:true, isParent:true, isMaster:true, parentId:true, amazonAsin:true,
    channelListings: { select: { id:true, channel:true, channelMarket:true, externalListingId:true, listingStatus:true } } },
})
const byId = new Map(all.map(p=>[p.id,p]))
const childrenOf = new Map()
for (const p of all) if (p.parentId){ if(!childrenOf.has(p.parentId))childrenOf.set(p.parentId,[]); childrenOf.get(p.parentId).push(p) }

// 1. soft-deleted products that STILL have channel listings (orphaned)
console.log('=== 1) SOFT-DELETED products that still have channel listings (orphaned) ===')
let orphanCount=0
for (const p of all) {
  if (p.deletedAt && p.channelListings.length>0) {
    orphanCount++
    console.log(`  ${p.sku}  deleted=${p.deletedAt.toISOString().slice(0,10)}  listings=${p.channelListings.length} [${p.channelListings.map(c=>`${c.channel}/${c.channelMarket}:${c.listingStatus??'∅'}${c.externalListingId?'':'(unpub)'}`).join(', ')}]`)
  }
}
if(!orphanCount) console.log('  none')

// 2. duplicate amazonAsin across DIFFERENT products (both live)
console.log('\n=== 2) DUPLICATE amazonAsin across live products ===')
const asinMap = new Map()
for (const p of all) if (p.amazonAsin && !p.deletedAt){ if(!asinMap.has(p.amazonAsin))asinMap.set(p.amazonAsin,[]); asinMap.get(p.amazonAsin).push(p.sku) }
let dupAsin=0
for (const [asin,skus] of asinMap) if (skus.length>1){ dupAsin++; console.log(`  ${asin}: ${skus.join(', ')}`) }
if(!dupAsin) console.log('  none')

// 3. LIVE parents/standalones and whether they map to a real Amazon family ASIN
console.log('\n=== 3) LIVE parents/standalone — Amazon-family match ===')
const liveParents = all.filter(p=>!p.deletedAt && (p.isParent||p.isMaster||(childrenOf.get(p.id)?.length??0)>0) )
for (const p of liveParents.sort((a,b)=>(a.sku>b.sku?1:-1))) {
  const kids = childrenOf.get(p.id)?.filter(k=>!k.deletedAt)??[]
  const match = p.amazonAsin && AMZ_ASINS.has(p.amazonAsin) ? '✓amazon' : (p.amazonAsin?`?asin ${p.amazonAsin} not in 14`:'✗NO ASIN')
  console.log(`  ${p.sku.padEnd(34)} kids=${String(kids.length).padStart(2)}  ${match}`)
}

// 4. LIVE non-child products with NO amazon listing at all (extra?) and unpublished-only
console.log('\n=== 4) LIVE products whose Amazon listings are ALL unpublished (ext=∅) ===')
let stale=0
for (const p of all) {
  if (p.deletedAt) continue
  const amz = p.channelListings.filter(c=>c.channel==='AMAZON')
  if (amz.length>0 && amz.every(c=>!c.externalListingId)) { stale++; console.log(`  ${p.sku}  amzListings=${amz.length} all-unpublished`) }
}
if(!stale) console.log('  none')

// 5. totals
const liveProducts = all.filter(p=>!p.deletedAt)
console.log(`\n=== TOTALS === all=${all.length} live=${liveProducts.length} softDeleted=${all.length-liveProducts.length} liveParents=${liveParents.length}`)
await prisma.$disconnect()
