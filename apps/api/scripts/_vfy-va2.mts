const { default: prisma } = await import('../src/db.js')
const mems = await prisma.sharedListingMembership.findMany({ select: { marketplace:true, parentSku:true, sku:true, status:true, flatFileSnapshot:true } })
const hits = mems.filter(m => { const s=m.flatFileSnapshot as any; return s && typeof s==='object' && 'aspect_Variantattributes' in s })
const nonEmpty = hits.filter(m => String((m.flatFileSnapshot as any).aspect_Variantattributes ?? '').trim() !== '')
console.log('status of the 27:', JSON.stringify(hits.reduce((a:any,m)=>{a[m.status]=(a[m.status]??0)+1;return a},{})))
console.log('status of the 9 non-empty:', JSON.stringify(nonEmpty.reduce((a:any,m)=>{a[`${m.status}`]=(a[`${m.status}`]??0)+1;return a},{})))
console.log('non-empty detail:', nonEmpty.map(m=>`${m.parentSku}/${m.sku}/${m.status}`))
// do the parent SKUs exist as parent products (so parent rows exist)?
const parents = [...new Set(hits.map(m=>m.parentSku))]
const prods = await prisma.product.findMany({ where: { sku: { in: parents } }, select: { sku:true, isParent:true, deletedAt:true, productType:true, channelListings:{ where:{channel:'EBAY'}, select:{region:true, syncStatus:true, externalListingId:true} } } })
for (const p of prods) console.log(`  parent ${p.sku} isParent=${p.isParent} deleted=${!!p.deletedAt} type=${p.productType} CLs=${JSON.stringify(p.channelListings)}`)
console.log('missing parent products:', parents.filter(s=>!prods.some(p=>p.sku===s)))
await prisma.$disconnect()
