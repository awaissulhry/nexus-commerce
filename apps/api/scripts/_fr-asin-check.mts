/** READ-ONLY: do FR listings share ASINs with IT (Build-International-Listings signature)? */
const { default: prisma } = await import('../src/db.js')
const skus = ['GALE-JACKET-YELLOW-MEN-L', 'GALE-JACKET-BLACK-MEN-M', 'AIRMESH-JACKET-BLACK-MEN-L', 'VENTRA-JACKET-L-YELLOW-MEN']
let shared = 0, distinct = 0, frMissing = 0
for (const sku of skus) {
  const rows = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', marketplace: { in: ['IT','DE','FR','ES'] }, product: { sku } },
    select: { marketplace: true, externalListingId: true, listingStatus: true, fulfillmentMethod: true },
  })
  const byMkt = Object.fromEntries(rows.map(r => [r.marketplace, r.externalListingId]))
  const it = byMkt['IT'], fr = byMkt['FR']
  console.log(`${sku}:`)
  for (const r of rows.sort((a,b)=>a.marketplace.localeCompare(b.marketplace))) console.log(`    ${r.marketplace}: ASIN=${r.externalListingId} ${r.listingStatus} ${r.fulfillmentMethod ?? ''}`)
  if (!fr) frMissing++
  else if (it && fr === it) shared++
  else distinct++
}
console.log(`\nFR shares IT ASIN (Pan-EU/BIL): ${shared} · FR distinct ASIN: ${distinct} · FR missing: ${frMissing}`)
// The decisive question: are FR ASINs ALSO present on IT (same ASIN = one Pan-EU catalog entry)?
await prisma.$disconnect()
