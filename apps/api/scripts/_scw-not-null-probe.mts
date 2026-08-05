// READ-ONLY probe: does `fulfillmentMethod: { not: 'FBA' }` match NULL rows in
// Prisma 6, and how many live listings carry a NULL fulfillmentMethod?
const prisma = (await import('../src/db.js')).default

const live = { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } } as const
const [total, nullFm, notFba, notFbaOrNull] = await Promise.all([
  prisma.channelListing.count({ where: { ...live } }),
  prisma.channelListing.count({ where: { ...live, fulfillmentMethod: null } }),
  prisma.channelListing.count({ where: { ...live, fulfillmentMethod: { not: 'FBA' } } }),
  prisma.channelListing.count({ where: { ...live, OR: [{ fulfillmentMethod: null }, { fulfillmentMethod: { not: 'FBA' } }] } }),
])
console.log(JSON.stringify({ total, nullFm, notFba, notFbaOrNull, notMatchesNull: notFba === notFbaOrNull }))

// Per-channel split of NULL-fm live listings (which channels are exposed)
const byChan = await prisma.channelListing.groupBy({
  by: ['channel'],
  where: { ...live, fulfillmentMethod: null },
  _count: { _all: true },
})
console.log('NULL-fm live listings by channel:', JSON.stringify(byChan.map((c) => ({ channel: c.channel, n: c._count._all }))))
await prisma.$disconnect(); process.exit(0)
