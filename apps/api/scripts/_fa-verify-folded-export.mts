const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')

const listings = await prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } }, select: { productId: true } })
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const rowPids = [...new Set([...listings.map(l=>l.productId), ...mems.map(m=>m.productId).filter(Boolean)])] as string[]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map(p=>[p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id) ?? id))]

// replicate resolveCanonicalMasters
const [withChildren, masterSkus] = await Promise.all([
  prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
  prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
])
const mastersWithChildren = new Set(withChildren.map(p=>p.parentId).filter(Boolean) as string[])
const childless = masterIds.filter(id => !mastersWithChildren.has(id))
const stemOfMaster = new Map<string,string>(); const canonicalByStem = new Map<string,string>()
const ordered = [...masterSkus].sort((a,b)=>{const sa=canonicalStem(a.sku),sb=canonicalStem(b.sku);const ea=a.sku.toUpperCase()===sa?0:1,eb=b.sku.toUpperCase()===sb?0:1;return ea-eb||a.sku.localeCompare(b.sku)})
for (const m of ordered){const stem=canonicalStem(m.sku);stemOfMaster.set(m.id,stem);if(mastersWithChildren.has(m.id)&&!canonicalByStem.has(stem))canonicalByStem.set(stem,m.id)}
const itemIdsByMaster=new Map<string,string[]>(); const canonByItem=new Map<string,string>()
if (childless.length){
  const cls = await prisma.channelListing.findMany({ where:{ productId:{in:childless}, externalListingId:{not:null}}, select:{productId:true, externalListingId:true}})
  const all=new Set<string>()
  for(const c of cls){ if(!c.externalListingId) continue; const a=itemIdsByMaster.get(c.productId)??[];a.push(c.externalListingId);itemIdsByMaster.set(c.productId,a);all.add(c.externalListingId)}
  if(all.size){
    const ms = await prisma.sharedListingMembership.findMany({where:{itemId:{in:[...all]}},select:{itemId:true,productId:true}})
    const pids=[...new Set(ms.map(m=>m.productId).filter(Boolean))] as string[]
    const mp = await prisma.product.findMany({where:{id:{in:pids}},select:{id:true,parentId:true}})
    const mop=new Map(mp.map(p=>[p.id,p.parentId??p.id]))
    for(const m of ms){ if(!m.productId||canonByItem.has(m.itemId))continue; const c=mop.get(m.productId); if(c&&mastersWithChildren.has(c))canonByItem.set(m.itemId,c)}
  }
}
const canon = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonByItem, canonicalByStem, stemOfMaster)
const skuById = new Map(masterSkus.map(m=>[m.id,m.sku]))
const folded = masterIds.filter(id => (canon.get(id) ?? id) !== id)
console.log('MASTERS', masterIds.length, 'GROUPS', new Set(masterIds.map(id=>canon.get(id)??id)).size, 'FOLDED', folded.length)
for (const f of folded) console.log('  folded', skuById.get(f), f, '->', skuById.get(canon.get(f)!), canon.get(f))

// simulate filterExportRows for each folded id and its canonical
for (const f of folded.slice(0,3)) {
  const c = canon.get(f)!
  const setF = rowPids.filter(pid => (canon.get(masterOf.get(pid) ?? pid) ?? masterOf.get(pid) ?? pid) === f)
  const setC = rowPids.filter(pid => (canon.get(masterOf.get(pid) ?? pid) ?? masterOf.get(pid) ?? pid) === c)
  const rowsF = listings.filter(l=>setF.includes(l.productId)).length + mems.filter(m=>m.productId&&setF.includes(m.productId)).length
  const rowsC = listings.filter(l=>setC.includes(l.productId)).length + mems.filter(m=>m.productId&&setC.includes(m.productId)).length
  console.log('EXPORT SIM', skuById.get(f), 'foldedId rows=', rowsF, ' canonicalId rows=', rowsC)
}
await prisma.$disconnect()
