const prisma = (await import('../src/db.js')).default
const cls = await prisma.channelListing.count({
  where: {
    isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] },
    product: { OR: [{ deletedAt: { not: null } }, { parent: { deletedAt: { not: null } } }] },
  },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const memPids = [...new Set(mems.map((m) => m.productId).filter((p): p is string => !!p))]
const deadMemPids = await prisma.product.count({
  where: { id: { in: memPids }, OR: [{ deletedAt: { not: null } }, { parent: { deletedAt: { not: null } } }] },
})
const delKidsOfLiveMasters = await prisma.product.count({ where: { deletedAt: { not: null }, parent: { deletedAt: null } } })
const clsOnThose = await prisma.channelListing.count({
  where: {
    isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] },
    product: { deletedAt: { not: null }, parent: { deletedAt: null } },
  },
})
console.log(JSON.stringify({ liveClsOnDeletedProducts: cls, deadMemProducts: deadMemPids, deletedKidsOfLiveMasters: delKidsOfLiveMasters, liveClsOnDeletedKidsOfLiveMasters: clsOnThose }))
await prisma.$disconnect(); process.exit(0)
