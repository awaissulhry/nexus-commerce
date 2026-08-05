/** READ-ONLY: verify multi-select OR-semantics + market normalisation using the
 *  SAME predicates the endpoint uses. Proves single vs multi vs union agree. */
const { default: prisma } = await import('../src/db.js')
const { marketMatches } = await import('../src/services/sync-control-product-view.js')

// Rebuild the row set the endpoint sees (channel/market only — enough for filters).
const [cl, mem] = await Promise.all([
  prisma.channelListing.findMany({
    where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: { productId: true, channel: true, marketplace: true },
  }),
  prisma.sharedListingMembership.findMany({
    where: { status: 'ACTIVE' },
    select: { productId: true, marketplace: true },
  }),
])
const rows = [
  ...cl.map((c) => ({ productId: c.productId, channel: c.channel, marketplace: c.marketplace })),
  ...mem.map((m) => ({ productId: m.productId ?? '', channel: 'EBAY', marketplace: m.marketplace })),
].filter((r) => r.productId)

// group rows by product (proxy for the endpoint's per-group children)
const byProduct = new Map<string, typeof rows>()
for (const r of rows) {
  const a = byProduct.get(r.productId) ?? []
  a.push(r)
  byProduct.set(r.productId, a)
}
const groups = [...byProduct.values()]

const listOf = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
function countChannels(csv: string): number {
  const chans = listOf(csv).map((x) => x.toUpperCase())
  return groups.filter((g) => !chans.length || g.some((c) => chans.includes(c.channel))).length
}
function countMarkets(csv: string): number {
  const mkts = listOf(csv)
  return groups.filter((g) => !mkts.length || g.some((c) => mkts.some((m) => marketMatches(c.marketplace, m) || c.marketplace === m))).length
}

const eb = countChannels('EBAY'), am = countChannels('AMAZON'), both = countChannels('EBAY,AMAZON'), none = countChannels('')
console.log(`CHANNEL  EBAY=${eb}  AMAZON=${am}  EBAY,AMAZON=${both}  (all=${none})`)
console.log(`  OR-semantics: multi >= max(single)? ${both >= Math.max(eb, am) ? 'PASS' : 'FAIL'}`)
console.log(`  multi <= all? ${both <= none ? 'PASS' : 'FAIL'}`)

const it = countMarkets('IT'), de = countMarkets('DE'), itde = countMarkets('IT,DE')
console.log(`MARKET   IT=${it}  DE=${de}  IT,DE=${itde}`)
console.log(`  OR-semantics: ${itde >= Math.max(it, de) ? 'PASS' : 'FAIL'}`)

// market normalisation: does 'IT' match EBAY_IT rows?
const ebayItRows = rows.filter((r) => r.marketplace === 'EBAY_IT').length
const matchedByIT = rows.filter((r) => marketMatches(r.marketplace, 'IT') || r.marketplace === 'IT').length
const plainIt = rows.filter((r) => r.marketplace === 'IT').length
console.log(`MARKET NORMALISATION: rows EBAY_IT=${ebayItRows} plain IT=${plainIt} → matched by 'IT'=${matchedByIT}`)
console.log(`  covers both forms? ${matchedByIT >= ebayItRows + plainIt ? 'PASS' : 'FAIL'}`)

// whitespace / dupes / empty tolerance
console.log(`TOLERANCE  ' EBAY , EBAY '=${countChannels(' EBAY , EBAY ')} (expect ${eb})  ','=${countChannels(',')} (expect ${none})`)
await prisma.$disconnect()
