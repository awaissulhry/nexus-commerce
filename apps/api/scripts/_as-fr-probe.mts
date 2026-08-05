/** READ-ONLY: FR listing state — interpret the FR:empty readback report. */
const { default: prisma } = await import('../src/db.js')
const byMp = await prisma.channelListing.groupBy({
  by: ['marketplace', 'isPublished'],
  where: { channel: 'AMAZON' },
  _count: true,
})
console.log('AMAZON listings by marketplace/published:')
for (const r of byMp.sort((a, b) => a.marketplace.localeCompare(b.marketplace)))
  console.log(`  ${r.marketplace} published=${r.isPublished}: ${r._count}`)
const frStatuses = await prisma.channelListing.groupBy({
  by: ['listingStatus'],
  where: { channel: 'AMAZON', marketplace: 'FR', isPublished: true },
  _count: true,
})
console.log('FR published by listingStatus:', frStatuses.map((s) => `${s.listingStatus}=${s._count}`).join(' ') || '(none)')
await prisma.$disconnect()
process.exit(0)
