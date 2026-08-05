/** READ-ONLY P0 part 2: listingStatus × isPublished × offerActive for key families + AIREON pools. */
const { default: prisma } = await import('../src/db.js')
for (const fam of ['MOSS', 'AIRMESH', 'AIREON', 'GALE']) {
  const rows = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', listingStatus: { notIn: ['ENDED', 'REMOVED'] }, product: { sku: { startsWith: fam } } },
    select: { listingStatus: true, isPublished: true, offerActive: true, quantity: true, marketplace: true, product: { select: { sku: true, fulfillmentMethod: true } }, fulfillmentMethod: true },
  })
  const fbm = rows.filter((l) => !((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA')))
  const agg: Record<string, number> = {}
  for (const l of fbm) {
    const k = `${l.listingStatus}/pub=${l.isPublished}/offer=${l.offerActive}/q${(l.quantity ?? 0) > 0 ? '+' : '0'}`
    agg[k] = (agg[k] ?? 0) + 1
  }
  console.log(fam, JSON.stringify(agg))
}
await prisma.$disconnect()
process.exit(0)
