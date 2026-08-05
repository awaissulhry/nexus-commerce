/** READ-ONLY: replicate the SCD.1 canonical resolution against prod → confirm grouping. */
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')

// rowPids ≈ products with published listings + active memberships (grid scope)
const [cl, mem] = await Promise.all([
  prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } }, select: { productId: true } }),
  prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } }),
])
const rowPids = [...new Set([...cl.map(x=>x.productId), ...mem.map(x=>x.productId).filter(Boolean) as string[]])]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map(p=>[p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map(id => masterOf.get(id) ?? id))]

// resolveCanonicalMasters (inline replica)
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
const stemOfMaster = new Map<string,string>(); const canonicalByStem = new Map<string,string>()
for (const m of masterSkus) { const st = canonicalStem(m.sku); stemOfMaster.set(m.id, st); if (mastersWithChildren.has(m.id) && !canonicalByStem.has(st)) canonicalByStem.set(st, m.id) }
const canon = resolveCanonicalMap(masterIds, mastersWithChildren, itemIdsByMaster, canonicalByItem, canonicalByStem, stemOfMaster)
const groups = new Set([...canon.values()])
console.log(`grid masters=${masterIds.length} → GROUPS=${groups.size}`)
// show the GALE + AIRMESH folding
const nameById = new Map((await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })).map(p=>[p.id,p.sku]))
const foldedByCanon = new Map<string,string[]>()
for (const [mid,cid] of canon) if (mid!==cid) (foldedByCanon.get(cid) ?? foldedByCanon.set(cid,[]).get(cid)!).push(nameById.get(mid)??mid)
for (const [cid,members] of foldedByCanon) console.log(`  ${nameById.get(cid)} ← folds in: ${members.join(', ')}`)
await prisma.$disconnect()
