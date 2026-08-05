/** READ-ONLY: is the IT≠DE quantity difference REAL (independent marketplaces)
 *  or just a stale read-back? Compare per-row read-back timestamps. */
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', product: { sku: 'GALE-JACKET-BLACK-MEN-S' } },
  select: { marketplace: true, quantity: true, fulfillmentMethod: true, followMasterQuantity: true,
            lastSyncedAt: true, updatedAt: true, externalListingId: true },
})
console.log('GALE-JACKET-BLACK-MEN-S across Amazon marketplaces:')
for (const r of rows.sort((a,b)=>a.marketplace.localeCompare(b.marketplace))) {
  console.log(`  ${r.marketplace.padEnd(6)} qty=${String(r.quantity).padEnd(5)} ${r.fulfillmentMethod ?? 'FBM'} follow=${r.followMasterQuantity}  asin=${r.externalListingId ?? '-'}`)
  console.log(`         lastSynced=${r.lastSyncedAt?.toISOString() ?? 'never'}  updated=${r.updatedAt.toISOString()}`)
}
// Same ASIN across markets? (Pan-EU shares the ASIN, not necessarily the quantity)
const asins = new Set(rows.map(r => r.externalListingId))
console.log(`\ndistinct ASINs across these markets: ${asins.size} → ${[...asins].join(', ')}`)

// Broader: how fresh are the non-IT read-backs overall?
const all = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
  select: { marketplace: true, lastSyncedAt: true },
})
const byM = new Map<string, {n:number; fresh:number; newest: Date|null}>()
const DAY = 24*60*60*1000
for (const r of all) {
  const m = r.marketplace.toUpperCase()
  const e = byM.get(m) ?? {n:0, fresh:0, newest:null}
  e.n++
  if (r.lastSyncedAt && Date.now() - r.lastSyncedAt.getTime() < 2*DAY) e.fresh++
  if (r.lastSyncedAt && (!e.newest || r.lastSyncedAt > e.newest)) e.newest = r.lastSyncedAt
  byM.set(m, e)
}
console.log('\nread-back freshness per marketplace (fresh = synced <48h):')
for (const [m, e] of [...byM.entries()].sort()) console.log(`  ${m.padEnd(6)} ${e.fresh}/${e.n} fresh   newest=${e.newest?.toISOString() ?? 'never'}`)
await prisma.$disconnect()
