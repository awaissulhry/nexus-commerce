const { default: prisma } = await import('../src/db.js')
const { canonicalStem } = await import('../src/services/sync-control-product-view.js')

const all = await prisma.product.findMany({ select: { id: true, sku: true, parentId: true } })
const withChildren = new Set(all.filter(p => p.parentId).map(p => p.parentId!))
const masters = all.filter(p => !p.parentId)
const childless = masters.filter(m => !withChildren.has(m.id))

// canonical-by-stem
const canonicalByStem = new Map<string,string>()
for (const m of [...masters].sort((a,b)=>a.sku.localeCompare(b.sku))) {
  const s = canonicalStem(m.sku)
  if (withChildren.has(m.id) && !canonicalByStem.has(s)) canonicalByStem.set(s, m.id)
}
const skuById = new Map(all.map(p=>[p.id,p.sku]))

let silent = 0, pooled = 0
for (const m of childless) {
  const cls = await prisma.channelListing.findMany({
    where: { productId: m.id, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
    select: { channel: true, marketplace: true, externalListingId: true, syncPaused: true, quantity: true },
  })
  if (cls.length === 0) continue
  const itemIds = cls.map(c=>c.externalListingId).filter(Boolean) as string[]
  const mems = itemIds.length ? await prisma.sharedListingMembership.findMany({ where: { itemId: { in: itemIds } }, select: { itemId: true, productId: true } }) : []
  const memPids = [...new Set(mems.map(x=>x.productId).filter(Boolean))] as string[]
  const memProds = memPids.length ? await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } }) : []
  const canonicals = new Set(memProds.map(p=>p.parentId ?? p.id).filter(c=>withChildren.has(c)))
  const stemCanon = canonicalByStem.get(canonicalStem(m.sku))
  const canon = canonicals.size ? [...canonicals][0] : (stemCanon && stemCanon !== m.id ? stemCanon : null)
  if (!canon) continue
  // does canonical group have ACTIVE memberships (=> PAUSE/ZERO_PIN 400s)?
  const pids = [canon, ...all.filter(p=>p.parentId===canon).map(p=>p.id)]
  const canonMems = await prisma.sharedListingMembership.count({ where: { productId: { in: pids }, status: 'ACTIVE' } })
  const tag = canonMems > 0 ? 'POOLED-canonical(PAUSE would 400)' : '*** SILENT-MISS POSSIBLE ***'
  if (canonMems > 0) pooled++; else silent++
  console.log(`${m.sku} -> canonical ${skuById.get(canon)} | ownCL=${cls.length} [${cls.map(c=>`${c.channel}:${c.marketplace} paused=${c.syncPaused} qty=${c.quantity}`).join(', ')}] canonActiveMems=${canonMems} ${tag}`)
}
console.log(`\nchildless-with-listings folded: pooled=${pooled} silentPossible=${silent}`)
await prisma.$disconnect()
