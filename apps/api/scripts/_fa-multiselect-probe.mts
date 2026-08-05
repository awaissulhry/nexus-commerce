/** READ-ONLY probe: sync-control multi-select filter contract. */
const { default: prisma } = await import('../src/db.js')

const cls = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { channel: true, marketplace: true },
})
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { marketplace: true },
})

const pairs = new Map<string, number>()
for (const c of cls) {
  const k = `LISTING ${c.channel}|${c.marketplace}`
  pairs.set(k, (pairs.get(k) ?? 0) + 1)
}
for (const m of mems) {
  const k = `SHARED EBAY|${m.marketplace}`
  pairs.set(k, (pairs.get(k) ?? 0) + 1)
}
console.log('=== channel|marketplace row counts ===')
for (const [k, v] of [...pairs.entries()].sort()) console.log(v.toString().padStart(6), k)

// Simulate the /listings endpoint filter with a CSV value (what the client sends)
const rows = [
  ...cls.map((c) => ({ channel: c.channel, marketplace: c.marketplace })),
  ...mems.map((m) => ({ channel: 'EBAY', marketplace: m.marketplace })),
]
const listingsFilter = (q: string) => rows.filter((r) => r.channel === q.toUpperCase()).length
console.log('\n=== GET /listings channel= semantics (single-value equality) ===')
console.log('channel=AMAZON        ->', listingsFilter('AMAZON'), 'rows')
console.log('channel=EBAY          ->', listingsFilter('EBAY'), 'rows')
console.log('channel=AMAZON,EBAY   ->', listingsFilter('AMAZON,EBAY'), 'rows  <-- what the UI sends when 2 channels are ticked')

const marketFilter = (q: string) =>
  rows.filter((r) => r.marketplace.toUpperCase().replace(/^EBAY_/, '') === q.toUpperCase()).length
console.log('\n=== GET /listings market= semantics ===')
console.log('market=IT             ->', marketFilter('IT'), 'rows')
console.log('market=DE             ->', marketFilter('DE'), 'rows')
console.log('market=IT,DE          ->', marketFilter('IT,DE'), 'rows  <-- 2 markets ticked')

// export path (filterExportRows) uses marketMatches(row, filter): strips EBAY_ from the ROW only
const marketMatches = (rowMkt: string, filter: string) =>
  rowMkt.toUpperCase().replace(/^EBAY_/, '') === filter.toUpperCase()
console.log('\n=== GET /export market= semantics (per-product page facet values are RAW) ===')
for (const f of ['IT', 'EBAY_IT', 'DEFAULT']) {
  console.log(`market=${f.padEnd(9)} ->`, rows.filter((r) => marketMatches(r.marketplace, f)).length, 'rows')
}
process.exit(0)
