// READ-ONLY: how are GALE FBA vs FBM wired? Focus on whether both have PUBLISHED
// Amazon offers for the same ASIN (true duplicate) or FBM is draft/internal.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

for (const parentSku of ['GALE-JACKET','GALE-JACKET-FBM']) {
  const p = await prisma.product.findUnique({ where:{sku:parentSku}, select:{ id:true, fulfillmentMethod:true, fulfillmentChannel:true } })
  const kids = await prisma.product.findMany({ where:{parentId:p.id}, select:{ id:true, sku:true, amazonAsin:true, fulfillmentMethod:true } })
  const listings = await prisma.channelListing.findMany({ where:{ channel:'AMAZON', productId:{in:kids.map(k=>k.id)} },
    select:{ productId:true, channelMarket:true, externalListingId:true, listingStatus:true, fulfillmentMethod:true, quantity:true } })
  const byPid = new Map(); for(const l of listings){ if(!byPid.has(l.productId))byPid.set(l.productId,[]); byPid.get(l.productId).push(l) }
  const pub = listings.filter(l=>l.externalListingId).length
  const draft = listings.filter(l=>!l.externalListingId).length
  console.log(`\n=== ${parentSku} === parent.fulfillmentMethod=${p.fulfillmentMethod} fulfillmentChannel=${p.fulfillmentChannel}  kids=${kids.length}`)
  console.log(`   Amazon listings: ${listings.length} total — PUBLISHED(ext set)=${pub}  DRAFT(ext ∅)=${draft}`)
  console.log(`   listingStatus: ${JSON.stringify(listings.reduce((o,l)=>{o[l.listingStatus??'∅']=(o[l.listingStatus??'∅']||0)+1;return o},{}))}`)
  console.log(`   fulfillmentMethod on listings: ${JSON.stringify(listings.reduce((o,l)=>{o[l.fulfillmentMethod??'∅']=(o[l.fulfillmentMethod??'∅']||0)+1;return o},{}))}`)
  // sample 1 child, all markets
  const s = kids.find(k=>/-M$|_M_FBM$/.test(k.sku)) ?? kids[0]
  console.log(`   sample child ${s.sku} (fm=${s.fulfillmentMethod}) asin=${s.amazonAsin}:`)
  for(const l of (byPid.get(s.id)??[])) console.log(`      [${l.channelMarket}] ext=${l.externalListingId??'∅'} status=${l.listingStatus??'∅'} fm=${l.fulfillmentMethod??'∅'} qty=${l.quantity??'∅'}`)
}
await prisma.$disconnect()
