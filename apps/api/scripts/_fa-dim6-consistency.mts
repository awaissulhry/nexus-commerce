/** DIM6 read-only probe: cross-surface filter parity for sync-control. */
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { channel: true, marketplace: true },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { marketplace: true },
})
const rows = [
  ...listings.map((l) => ({ channel: l.channel, marketplace: l.marketplace })),
  ...mems.map((m) => ({ channel: 'EBAY', marketplace: m.marketplace })),
]
console.log('TOTAL sync-control rows:', rows.length)

const byChannel: Record<string, number> = {}
const byMarket: Record<string, number> = {}
for (const r of rows) {
  byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1
  const m = r.marketplace.toUpperCase().replace(/^EBAY_/, '')
  byMarket[m] = (byMarket[m] ?? 0) + 1
}
console.log('byChannel:', byChannel)
console.log('byMarket:', byMarket)

// exact server predicate from /listings (line 279-281)
const single = rows.filter((r) => r.channel === 'AMAZON')
const csv = rows.filter((r) => r.channel === 'AMAZON,EBAY'.toUpperCase())
console.log(`/listings?channel=AMAZON        -> ${single.length} rows`)
console.log(`/listings?channel=AMAZON,EBAY   -> ${csv.length} rows  <-- multi-select`)

const mSingle = rows.filter((r) => r.marketplace.toUpperCase().replace(/^EBAY_/, '') === 'IT')
const mCsv = rows.filter((r) => r.marketplace.toUpperCase().replace(/^EBAY_/, '') === 'IT,DE')
console.log(`/listings?market=IT             -> ${mSingle.length} rows`)
console.log(`/listings?market=IT,DE          -> ${mCsv.length} rows  <-- multi-select`)

// /export predicate (filterExportRows): chan exact, market via marketMatches
const marketMatches = (rowMarketplace: string, filter: string) =>
  rowMarketplace.toUpperCase().replace(/^EBAY_/, '') === filter.toUpperCase()
console.log(`/export?channel=AMAZON,EBAY     -> ${rows.filter((r) => r.channel === 'AMAZON,EBAY').length} rows`)
console.log(`/export?market=IT,DE            -> ${rows.filter((r) => marketMatches(r.marketplace, 'IT,DE')).length} rows`)
console.log(`/export?lane=LISTING,SHARED     -> ${['LISTING', 'SHARED'].filter((l) => l === 'LISTING,SHARED').length} lanes match`)

await prisma.$disconnect()
