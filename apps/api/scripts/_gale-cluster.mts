/** READ-ONLY: how are GALE-JACKET and its ALT/duplicate families related? */
const { default: prisma } = await import('../src/db.js')
const prods = await prisma.product.findMany({
  where: { OR: [{ sku: { contains: 'GALE' } }, { name: { contains: 'GALE', mode: 'insensitive' } }, { name: { contains: 'Gale' } }] },
  select: { id: true, sku: true, name: true, parentId: true },
})
const masters = prods.filter(p => !p.parentId)
console.log(`GALE-ish products=${prods.length} (masters=${masters.length}, variants=${prods.length - masters.length})`)
for (const m of masters) {
  const variants = await prisma.product.findMany({ where: { parentId: m.id }, select: { id: true, sku: true } })
  const cls = await prisma.channelListing.groupBy({ by: ['channel'], where: { productId: { in: [m.id, ...variants.map(v=>v.id)] } }, _count: { _all: true } })
  const mem = await prisma.sharedListingMembership.findMany({ where: { productId: { in: [m.id, ...variants.map(v=>v.id)] }, status: 'ACTIVE' }, select: { itemId: true } })
  console.log(`\nMASTER ${m.sku}  "${(m.name??'').slice(0,42)}"`)
  console.log(`  variants=${variants.length}  channelListings=${JSON.stringify(cls.map(c=>`${c.channel}:${c._count._all}`))}  eBay itemIds=${new Set(mem.map(x=>x.itemId)).size}`)
  console.log(`  sample variant SKUs: ${variants.slice(0,3).map(v=>v.sku).join(', ')}`)
}
// KEY: do the ALT masters' variant SKUs OVERLAP with the real GALE's? (shared-SKU pooling)
console.log('\n=== variant-SKU overlap across masters (shared pool signature) ===')
const skusByMaster = new Map<string, Set<string>>()
for (const m of masters) {
  const vs = await prisma.product.findMany({ where: { parentId: m.id }, select: { sku: true } })
  skusByMaster.set(m.sku, new Set(vs.map(v=>v.sku)))
}
const arr = [...skusByMaster.entries()]
for (let i=0;i<arr.length;i++) for (let j=i+1;j<arr.length;j++) {
  const [a,sa]=arr[i], [b,sb]=arr[j]; const overlap=[...sa].filter(x=>sb.has(x)).length
  if (overlap>0) console.log(`  ${a} ∩ ${b} = ${overlap} shared variant SKUs (of ${sa.size}/${sb.size})`)
}
await prisma.$disconnect()
