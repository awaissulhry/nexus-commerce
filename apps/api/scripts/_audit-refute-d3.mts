const { default: prisma } = await import('../src/db.js')

const gale = await prisma.product.findMany({
  where: { sku: { contains: 'GALE' } },
  select: { id: true, sku: true, parentId: true },
})
const masters = gale.filter(p => !p.parentId)
const childOwning = new Set(gale.filter(p => p.parentId).map(p => p.parentId!))
console.log('GALE masters:', masters.map(m => `${m.sku}${childOwning.has(m.id) ? ' [CANONICAL owns children]' : ' [childless]'}`).join('\n  '))

for (const m of masters) {
  const pids = [m.id, ...gale.filter(p => p.parentId === m.id).map(p => p.id)]
  const cls = await prisma.channelListing.count({ where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } } })
  const clsOwn = await prisma.channelListing.count({ where: { productId: m.id, isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } } })
  const mem = await prisma.sharedListingMembership.count({ where: { productId: { in: pids }, status: 'ACTIVE' } })
  console.log(`${m.sku}: pids=${pids.length} publishedCL(all)=${cls} publishedCL(masterOwn)=${clsOwn} activeMemberships=${mem}`)
}
await prisma.$disconnect()
