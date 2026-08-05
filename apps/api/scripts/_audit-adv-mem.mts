const { default: prisma } = await import('../src/db.js')
// Emulate masterIds expansion for a few canonical masters
const masters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true } })
const rows: any[] = []
for (const m of masters) {
  const variants = await prisma.product.findMany({ where: { OR: [{ id: m.id }, { parentId: m.id }] }, select: { id: true } })
  const pids = variants.map(v => v.id)
  const [cls, mems] = await Promise.all([
    prisma.channelListing.count({ where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } } }),
    prisma.sharedListingMembership.count({ where: { productId: { in: pids }, status: 'ACTIVE' } }),
  ])
  if (mems > 0 || cls > 0) rows.push({ sku: m.sku, listings: cls, mems })
}
rows.sort((a,b)=>b.mems-a.mems)
console.log(JSON.stringify(rows.slice(0,25), null, 1))
console.log('masters with mems>0:', rows.filter(r=>r.mems>0).length, 'of', rows.length)
await prisma.$disconnect()
