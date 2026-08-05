/** READ-ONLY: what would "IT follows the pool, every other market goes to 0"
 *  actually touch? The danger: Amazon Pan-EU keeps ONE quantity per SKU across
 *  EU marketplaces, so zeroing DE/FR/ES for a SKU that is ALSO live on IT would
 *  zero the IT listing too. */
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: {
    isPublished: true,
    listingStatus: { notIn: ['ENDED', 'REMOVED'] },
    product: { deletedAt: null, OR: [{ parentId: null }, { parent: { deletedAt: null } }] },
  },
  select: {
    productId: true, channel: true, marketplace: true, fulfillmentMethod: true,
    followMasterQuantity: true, quantity: true, externalListingId: true,
    product: { select: { sku: true } },
  },
})

const norm = (m: string) => m.toUpperCase().replace(/^EBAY_/, '')
const byBucket = new Map<string, number>()
for (const l of listings) {
  const k = `${l.channel}:${norm(l.marketplace)}:${l.fulfillmentMethod ?? 'FBM'}`
  byBucket.set(k, (byBucket.get(k) ?? 0) + 1)
}
console.log('=== SCOPE (channel : market : fulfilment) ===')
for (const [k, n] of [...byBucket.entries()].sort()) console.log(`  ${k.padEnd(28)} ${n}`)

// --- the Pan-EU collision test ---
const itSkus = new Map<string, Set<string>>()   // channel -> skus live on IT
const nonItSkus = new Map<string, Map<string, string[]>>() // channel -> sku -> markets
for (const l of listings) {
  const sku = l.product?.sku ?? ''
  if (!sku) continue
  const m = norm(l.marketplace)
  if (m === 'IT') {
    if (!itSkus.has(l.channel)) itSkus.set(l.channel, new Set())
    itSkus.get(l.channel)!.add(sku)
  } else {
    if (!nonItSkus.has(l.channel)) nonItSkus.set(l.channel, new Map())
    const mm = nonItSkus.get(l.channel)!
    mm.set(sku, [...(mm.get(sku) ?? []), m])
  }
}
console.log('\n=== PAN-EU COLLISION: non-IT rows whose SKU is ALSO live on IT ===')
for (const [channel, mm] of nonItSkus) {
  const it = itSkus.get(channel) ?? new Set()
  const collide = [...mm.entries()].filter(([sku]) => it.has(sku))
  console.log(`  ${channel}: ${collide.length} of ${mm.size} non-IT SKUs also live on IT`)
  for (const [sku, mkts] of collide.slice(0, 6)) console.log(`      ${sku} → ${[...new Set(mkts)].join(',')} (also IT)`)
  if (collide.length > 6) console.log(`      … +${collide.length - 6} more`)
}

// --- what is FBA (untouchable) among the non-IT rows? ---
const nonIt = listings.filter((l) => norm(l.marketplace) !== 'IT')
const fba = nonIt.filter((l) => l.fulfillmentMethod === 'FBA' || l.fulfillmentMethod === 'AFN')
console.log(`\n=== NON-IT ROWS: ${nonIt.length} total · ${fba.length} FBA (Amazon-managed, never writable) · ${nonIt.length - fba.length} writable`)
const nonItByMkt = new Map<string, number>()
for (const l of nonIt) nonItByMkt.set(`${l.channel}:${norm(l.marketplace)}`, (nonItByMkt.get(`${l.channel}:${norm(l.marketplace)}`) ?? 0) + 1)
for (const [k, n] of [...nonItByMkt.entries()].sort()) console.log(`    ${k.padEnd(20)} ${n}`)

// --- IT rows not yet following ---
const it = listings.filter((l) => norm(l.marketplace) === 'IT')
const itFba = it.filter((l) => l.fulfillmentMethod === 'FBA' || l.fulfillmentMethod === 'AFN')
const itNotFollowing = it.filter((l) => !l.followMasterQuantity && !(l.fulfillmentMethod === 'FBA' || l.fulfillmentMethod === 'AFN'))
console.log(`\n=== IT ROWS: ${it.length} total · ${itFba.length} FBA (skipped) · ${itNotFollowing.length} writable rows NOT following yet`)
const itByChan = new Map<string, number>()
for (const l of itNotFollowing) itByChan.set(l.channel, (itByChan.get(l.channel) ?? 0) + 1)
for (const [k, n] of itByChan) console.log(`    ${k}: ${n} to flip to Follow`)

// --- eBay shared pools that span markets (one itemId serving >1 market) ---
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { itemId: true, marketplace: true, sku: true },
})
const mktsByItem = new Map<string, Set<string>>()
for (const m of mems) {
  if (!mktsByItem.has(m.itemId)) mktsByItem.set(m.itemId, new Set())
  mktsByItem.get(m.itemId)!.add(norm(m.marketplace))
}
const spanning = [...mktsByItem.entries()].filter(([, s]) => s.size > 1)
console.log(`\n=== eBay shared pools: ${mktsByItem.size} items · ${spanning.length} spanning >1 market`)
for (const [id, s] of spanning.slice(0, 8)) console.log(`    #${id} → ${[...s].join(',')}`)

// SKUs shared between an IT eBay pool and a non-IT one
const itPoolSkus = new Set(mems.filter((m) => norm(m.marketplace) === 'IT').map((m) => m.sku))
const nonItPoolShared = mems.filter((m) => norm(m.marketplace) !== 'IT' && itPoolSkus.has(m.sku))
console.log(`    non-IT pool rows whose SKU also sits in an IT pool: ${nonItPoolShared.length}`)
await prisma.$disconnect()
