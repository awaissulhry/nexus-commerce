import { PrismaClient } from '@prisma/client'
const p=new PrismaClient({datasources:{db:{url:process.argv[2]}}})
const root = await p.product.findFirst({ where:{ sku:'AIREON', parentId:null, deletedAt:null }, select:{ id:true, variationAxes:true, variationTheme:true } })
const kids = await p.product.findMany({ where:{ parentId: root!.id, deletedAt:null }, select:{ sku:true, categoryAttributes:true, variantAttributes:true }, orderBy:{ sku:'asc' } })
let variations=0, legacy=0
for (const k of kids) {
  const v = ((k.categoryAttributes ?? {}) as any).variations ?? {}
  if (Object.keys(v).length) variations++
  if (Object.keys((k.variantAttributes ?? {}) as any).length) legacy++
}
console.log(`AIREON: ${kids.length} children | declared axes ${JSON.stringify(root!.variationAxes)} | Product.variationTheme ${JSON.stringify(root!.variationTheme)}`)
console.log(`  children with categoryAttributes.variations : ${variations} of ${kids.length}`)
console.log(`  children with Product.variantAttributes     : ${legacy} of ${kids.length}`)
console.log('  sample SKUs:', kids.slice(0,4).map(k=>k.sku).join('  '))
const l = await p.channelListing.findFirst({ where:{ productId: root!.id, channel:'EBAY' }, select:{ marketplace:true, platformAttributes:true, externalListingId:true } })
const pa=(l?.platformAttributes??{}) as any
console.log(`  eBay parent listing: ${l?.marketplace??'(none)'} ext=${l?.externalListingId??'null'} _variationAxes=${JSON.stringify(pa._variationAxes??null)} _axisValueOrder keys=${JSON.stringify(Object.keys(pa._axisValueOrder??{}))}`)
await p.$disconnect()
