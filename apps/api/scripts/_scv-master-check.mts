/** READ-ONLY: top masters BY variant count (via parentId), with pool rollup. */
const { default: prisma } = await import('../src/db.js')
const kids = await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { not: null } }, _count: { _all: true }, orderBy: { _count: { parentId: 'desc' } }, take: 6 })
for (const k of kids) {
  const mid = k.parentId!
  const master = await prisma.product.findUnique({ where: { id: mid }, select: { sku: true, name: true } })
  const variants = await prisma.product.findMany({ where: { parentId: mid }, select: { id: true } })
  const pids = [mid, ...variants.map(v=>v.id)]
  const levels = await prisma.stockLevel.groupBy({ by: ['productId'], where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } }, _sum: { available: true } })
  const poolByPid = new Map(levels.map(l=>[l.productId, l._sum.available ?? 0]))
  const poolTotal = pids.reduce((s,pid)=>s+(poolByPid.get(pid)??0),0)
  const inStock = pids.filter(pid=>(poolByPid.get(pid)??0)>0).length
  console.log(`${master?.sku} (${master?.name?.slice(0,32)})  variants=${variants.length} poolTotal=${poolTotal} inStock=${inStock}/${pids.length}`)
}
await prisma.$disconnect()
