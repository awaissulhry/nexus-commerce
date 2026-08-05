/** READ-ONLY: how do sync-control rows map onto the master→variant hierarchy? */
const { default: prisma } = await import('../src/db.js')

// productIds that appear in sync-control rows (published listings + active memberships)
const [cl, mem] = await Promise.all([
  prisma.channelListing.findMany({ where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } }, select: { productId: true } }),
  prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } }),
])
const ids = [...new Set([...cl.map(x=>x.productId), ...mem.map(x=>x.productId).filter(Boolean) as string[]])]
const prods = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, parentId: true } })
const masters = prods.filter(p=>!p.parentId)
const variants = prods.filter(p=>p.parentId)
console.log(`sync-control productIds=${ids.length}  masters(parentId=null)=${masters.length}  variants=${variants.length}`)

// distinct masters if we roll variants up to their parent
const masterOf = new Map(prods.map(p=>[p.id, p.parentId ?? p.id]))
const rolledMasters = new Set([...ids].map(id => masterOf.get(id) ?? id))
console.log(`distinct MASTERS after rollup = ${rolledMasters.size}`)

// listing-row count per master (how deep would a master's child list get?)
const { default: p2 } = await import('../src/db.js')
// approximate: count rows per productId, then bucket by master
const rowCounts = new Map<string, number>()
for (const x of cl) rowCounts.set(x.productId, (rowCounts.get(x.productId)??0)+1)
for (const x of mem) if (x.productId) rowCounts.set(x.productId, (rowCounts.get(x.productId)??0)+1)
const perMaster = new Map<string, number>()
for (const [pid, n] of rowCounts) { const mid = masterOf.get(pid) ?? pid; perMaster.set(mid, (perMaster.get(mid)??0)+n) }
const sizes = [...perMaster.values()].sort((a,b)=>b-a)
console.log(`rows-per-master: max=${sizes[0]} p50=${sizes[Math.floor(sizes.length/2)]} min=${sizes[sizes.length-1]}  mastersWith>50rows=${sizes.filter(s=>s>50).length}`)

// do masters themselves carry channel listings? (Amazon parent ASIN pattern)
const masterIds = new Set(masters.map(m=>m.id))
const masterListingRows = cl.filter(x=>masterIds.has(x.productId)).length
const masterMemRows = mem.filter(x=>x.productId && masterIds.has(x.productId)).length
console.log(`rows sitting directly on a MASTER: channelListings=${masterListingRows} memberships=${masterMemRows}`)
await prisma.$disconnect()
