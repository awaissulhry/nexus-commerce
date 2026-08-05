const { default: prisma } = await import('../src/db.js')
const re = /variantattributes/i
// 1. SLM.variationSpecifics
const mems = await prisma.sharedListingMembership.findMany({ select: { parentSku:true, sku:true, variationSpecifics:true } })
const vsHits = mems.filter(m => { const v=m.variationSpecifics as any; return v && typeof v==='object' && Object.keys(v).some(k=>re.test(k)) })
console.log('SLM.variationSpecifics containing a variantAttributes-ish key:', vsHits.length, vsHits.slice(0,5).map(m=>`${m.parentSku}/${m.sku}`))
// 2. eBay CL platformAttributes.itemSpecifics
const cls = await prisma.channelListing.findMany({ where:{channel:'EBAY'}, select:{ marketplace:true, platformAttributes:true, product:{select:{sku:true}} } })
const isHits = cls.filter(c => { const isp=(c.platformAttributes as any)?.itemSpecifics; return isp && typeof isp==='object' && Object.keys(isp).some(k=>re.test(k)) })
console.log('eBay CL.platformAttributes.itemSpecifics containing it:', isHits.length, isHits.slice(0,5).map(c=>`${c.marketplace}/${c.product?.sku}`))
// 3. Product.categoryAttributes.variations
const prods = await prisma.product.findMany({ where:{ deletedAt:null }, select:{ sku:true, categoryAttributes:true, variantAttributes:true } })
const caHits = prods.filter(p => { const v=(p.categoryAttributes as any)?.variations; return v && typeof v==='object' && Object.keys(v).some(k=>re.test(k)) })
console.log('Product.categoryAttributes.variations containing it:', caHits.length, caHits.slice(0,5).map(p=>p.sku))
// 4. any product whose variantAttributes VALUES are objects (would String() to [object Object])
const objVals = prods.filter(p => { const v=p.variantAttributes as any; return v && typeof v==='object' && Object.values(v).some(x=>x && typeof x==='object') })
console.log('Products whose variantAttributes has object values:', objVals.length, objVals.slice(0,5).map(p=>p.sku))
// 5. any OTHER "[object Object]" aspect value anywhere in snapshots
let objAspect = 0; const objKeys = new Map<string,number>()
const mems2 = await prisma.sharedListingMembership.findMany({ select:{ flatFileSnapshot:true } })
for (const m of mems2) { const s=m.flatFileSnapshot as any; if(!s||typeof s!=='object')continue; for(const[k,v]of Object.entries(s)){ if(k.startsWith('aspect_')&&String(v)==='[object Object]'){objAspect++;objKeys.set(k,(objKeys.get(k)??0)+1)} } }
console.log('SLM snapshot aspect_* cells equal to "[object Object]":', objAspect, JSON.stringify(Object.fromEntries(objKeys)))
let clObj = 0; const clKeys = new Map<string,number>()
for (const c of await prisma.channelListing.findMany({ where:{channel:'EBAY'}, select:{flatFileSnapshot:true} })) { const s=c.flatFileSnapshot as any; if(!s||typeof s!=='object')continue; for(const[k,v]of Object.entries(s)){ if(k.startsWith('aspect_')&&String(v)==='[object Object]'){clObj++;clKeys.set(k,(clKeys.get(k)??0)+1)} } }
console.log('eBay CL snapshot aspect_* cells equal to "[object Object]":', clObj, JSON.stringify(Object.fromEntries(clKeys)))
await prisma.$disconnect()
