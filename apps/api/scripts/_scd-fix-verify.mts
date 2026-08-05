/** READ-ONLY: confirm corrected variantCount (folded duplicate masters excluded)
 *  and that group scoping picks up the folded copies' listings (export fix). */
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')

const [cl, mem] = await Promise.all([
  prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } }, select: { productId: true } }),
  prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } }),
])
const rowPids = [...new Set([...cl.map(x=>x.productId), ...mem.map(x=>x.productId).filter(Boolean) as string[]])]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map(p=>[p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id) ?? id))]
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const mastersWithChildren = new Set(withChildren.map(p=>p.parentId).filter((x): x is string => !!x))
const childless = masterIds.filter(id => !mastersWithChildren.has(id))
const itemIdsByMaster = new Map<string,string[]>(); const canonicalByItem = new Map<string,string>()
const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const allItems = new Set<string>()
for (const c of cls) { if(!c.externalListingId) continue; (itemIdsByMaster.get(c.productId) ?? itemIdsByMaster.set(c.productId,[]).get(c.productId)!).push(c.externalListingId); allItems.add(c.externalListingId) }
const mems = allItems.size ? await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItems] } }, select: { itemId: true, productId: true } }) : []
const memProducts = await prisma.product.findMany({ where: { id: { in: [...new Set(mems.map(m=>m.productId).filter(Boolean) as string[])] } }, select: { id: true, parentId: true } })
const masterOfProduct = new Map(memProducts.map(p=>[p.id, p.parentId ?? p.id]))
for (const m of mems) { if(!m.productId || canonicalByItem.has(m.itemId)) continue; const c = masterOfProduct.get(m.productId); if (c && mastersWithChildren.has(c)) canonicalByItem.set(m.itemId, c) }
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })
const ordered = [...masterSkus].sort((a,b)=>{const sa=canonicalStem(a.sku),sb=canonicalStem(b.sku);const ea=a.sku.toUpperCase()===sa?0:1,eb=b.sku.toUpperCase()===sb?0:1;return ea-eb||a.sku.localeCompare(b.sku)})
const stemOfMaster = new Map<string,string>(); const canonicalByStem = new Map<string,string>()
for (const m of ordered) { const st=canonicalStem(m.sku); stemOfMaster.set(m.id, st); if (mastersWithChildren.has(m.id) && !canonicalByStem.has(st)) canonicalByStem.set(st, m.id) }
const canon = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalByItem, canonicalByStem, stemOfMaster)

const membersByGroup = new Map<string,string[]>()
for (const mid of masterIds) { const gid = canon.get(mid) ?? mid; if (gid!==mid) (membersByGroup.get(gid) ?? membersByGroup.set(gid,[]).get(gid)!).push(mid) }
const skuById = new Map(masterSkus.map(p=>[p.id,p.sku]))

// per-group counts, OLD vs NEW
const byGroup = new Map<string,Set<string>>()
for (const pid of rowPids) { const gid = canon.get(masterOf.get(pid) ?? pid) ?? (masterOf.get(pid) ?? pid); (byGroup.get(gid) ?? byGroup.set(gid,new Set()).get(gid)!).add(pid) }
for (const sku of ['GALE-JACKET','AIREON','xavia-knee-slider']) {
  const gid = masterSkus.find(m=>m.sku===sku)?.id
  if (!gid) continue
  const pids = byGroup.get(gid) ?? new Set()
  const folded = new Set(membersByGroup.get(gid) ?? [])
  const realVariants = [...pids].filter(p=>!folded.has(p))
  const trueVariantCount = await prisma.product.count({ where: { parentId: gid } })
  console.log(`${sku}: OLD var=${pids.size}  NEW var=${realVariants.length}  (actual child products=${trueVariantCount})  folded copies=${folded.size}`)
  // export scope: rows in group (should include folded copies' listings)
  console.log(`   export scope productIds=${pids.size} (includes ${folded.size} folded copies → their listings now exported)`)
}
await prisma.$disconnect()
