const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem, omitChildrenInList } = await import('../src/services/sync-control-product-view.js')

const listings = await prisma.channelListing.findMany({ select: { productId: true } })
const mems0 = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const rowPids = [...new Set([...listings.map(l=>l.productId), ...(mems0.map(m=>m.productId).filter(Boolean) as string[])])]
const rowProducts = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id:true, parentId:true, sku:true } })
const masterOf = new Map(rowProducts.map(p=>[p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id=>masterOf.get(id) ?? id))]

// --- replicate resolveCanonicalMasters ---
const withChildren = await prisma.product.findMany({ where:{ parentId:{ in: masterIds } }, select:{ parentId:true }, distinct:['parentId'] })
const masterSkus = await prisma.product.findMany({ where:{ id:{ in: masterIds } }, select:{ id:true, sku:true } })
const mastersWithChildren = new Set(withChildren.map(p=>p.parentId).filter(Boolean) as string[])
const childless = masterIds.filter(id=>!mastersWithChildren.has(id))
const stemOfMaster = new Map<string,string>(); const canonicalByStem = new Map<string,string>()
const orderedMasters = [...masterSkus].sort((a,b)=>{const [sa,sb]=[canonicalStem(a.sku),canonicalStem(b.sku)];const [ea,eb]=[a.sku.toUpperCase()===sa?0:1,b.sku.toUpperCase()===sb?0:1];return ea-eb||a.sku.localeCompare(b.sku)})
for (const m of orderedMasters){const stem=canonicalStem(m.sku);stemOfMaster.set(m.id,stem);if(mastersWithChildren.has(m.id)&&!canonicalByStem.has(stem))canonicalByStem.set(stem,m.id)}
const itemIdsByMaster = new Map<string,string[]>(); const canonicalMasterByItemId = new Map<string,string>()
if (childless.length){
  const cls = await prisma.channelListing.findMany({ where:{ productId:{ in: childless }, externalListingId:{ not:null } }, select:{ productId:true, externalListingId:true } })
  const allItemIds = new Set<string>()
  for (const c of cls){ if(!c.externalListingId) continue; const a=itemIdsByMaster.get(c.productId)??[];a.push(c.externalListingId);itemIdsByMaster.set(c.productId,a);allItemIds.add(c.externalListingId) }
  if (allItemIds.size){
    const mems = await prisma.sharedListingMembership.findMany({ where:{ itemId:{ in:[...allItemIds] } }, select:{ itemId:true, productId:true } })
    const memPids=[...new Set(mems.map(m=>m.productId).filter(Boolean) as string[])]
    const memProducts = await prisma.product.findMany({ where:{ id:{ in: memPids } }, select:{ id:true, parentId:true } })
    const mop = new Map(memProducts.map(p=>[p.id,p.parentId??p.id]))
    for (const m of mems){ if(!m.productId||canonicalMasterByItemId.has(m.itemId)) continue; const c=mop.get(m.productId); if(c&&mastersWithChildren.has(c)) canonicalMasterByItemId.set(m.itemId,c) }
  }
}
const canonicalOf = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
// --- end replicate ---

const membersByGroup = new Map<string,string[]>()
for (const mid of masterIds){ const g=canonicalOf.get(mid)??mid; if(g!==mid){const a=membersByGroup.get(g)??[];a.push(mid);membersByGroup.set(g,a)} }
const groupIds=[...new Set(masterIds.map(m=>canonicalOf.get(m)??m))]
const groupIdOf=(pid:string)=>{const m=masterOf.get(pid)??pid;return canonicalOf.get(m)??m}
const byGroup=new Map<string,Set<string>>()
for(const pid of rowPids){const g=groupIdOf(pid);const s=byGroup.get(g)??new Set();s.add(pid);byGroup.set(g,s)}
const metaById=new Map(masterSkus.map(p=>[p.id,p.sku]))

const out:any[]=[]
for(const gid of groupIds){
  const allPids=[...(byGroup.get(gid)??[])]
  const folded=new Set(membersByGroup.get(gid)??[])
  const variantPids=allPids.filter(p=>!folded.has(p))
  const realVariants=variantPids.filter(p=>(masterOf.get(p)??p)!==p)
  out.push({sku:metaById.get(gid),shipped_vc:variantPids.length,pre_scd1c:allPids.length,realOnly:realVariants.length,selfCounted:variantPids.length-realVariants.length,omit_shipped:omitChildrenInList(variantPids.length),omit_real:omitChildrenInList(realVariants.length)})
}
out.sort((a,b)=>b.shipped_vc-a.shipped_vc)
console.table(out)
await prisma.$disconnect()
