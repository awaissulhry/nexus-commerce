// READ-ONLY: policy-resume recascade collects productIds ONLY from
// channelListing(channel=EBAY). How many ACTIVE shared-membership products
// would that miss (no live EBAY ChannelListing of their own)?
const prisma = (await import('../src/db.js')).default
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { productId: true, sku: true },
})
const pids = [...new Set(mems.map((m) => m.productId).filter((p): p is string => !!p))]
const withEbayCl = new Set(
  (await prisma.channelListing.findMany({
    where: { productId: { in: pids }, channel: 'EBAY', listingStatus: { not: 'ENDED' } },
    select: { productId: true },
  })).map((c) => c.productId),
)
const missed = pids.filter((p) => !withEbayCl.has(p))
console.log(JSON.stringify({ activeMemberships: mems.length, memberProducts: pids.length, coveredByEbayCl: withEbayCl.size, missedProducts: missed.length }))
await prisma.$disconnect(); process.exit(0)
