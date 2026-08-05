/** READ-ONLY: exact enumeration of DE eBay ChannelListing rows + everything that references them.
 * NO WRITES. Produces the evidence base for the DE-draft deletion plan. */
const { default: prisma } = await import('../src/db.js')

const J = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))

// ── 1. every eBay ChannelListing row, bucketed by market ──────────────────
const all = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: {
    id: true, productId: true, channel: true, channelMarket: true, region: true, marketplace: true,
    externalListingId: true, externalParentId: true, platformProductId: true,
    listingStatus: true, isPublished: true, offerActive: true, syncPaused: true,
    quantity: true, price: true, createdAt: true, updatedAt: true, lastSyncedAt: true,
    product: { select: { id: true, sku: true, name: true, deletedAt: true, parentId: true } },
  },
  orderBy: [{ marketplace: 'asc' }, { createdAt: 'asc' }],
})
const norm = (c: (typeof all)[number]) => (c.marketplace && c.marketplace !== 'DEFAULT' ? c.marketplace : c.region || c.channelMarket || '?').toUpperCase()

const byMkt: Record<string, { total: number; live: number; draft: number }> = {}
for (const c of all) {
  const m = norm(c)
  byMkt[m] ??= { total: 0, live: 0, draft: 0 }
  byMkt[m].total++
  if (c.externalListingId) byMkt[m].live++
  else byMkt[m].draft++
}
console.log('=== 1. eBay ChannelListing rows by market (live = has externalListingId) ===')
console.log('total eBay rows:', all.length)
console.log(J(byMkt))

// marketplace vs channelMarket vs region disagreement — the where-clause trap
console.log('\n=== 1b. key-field combinations present (marketplace | channelMarket | region) ===')
const combos: Record<string, number> = {}
for (const c of all) combos[`${c.marketplace} | ${c.channelMarket} | ${c.region}`] = (combos[`${c.marketplace} | ${c.channelMarket} | ${c.region}`] || 0) + 1
console.log(J(combos))

const de = all.filter((c) => norm(c) === 'DE')
const it = all.filter((c) => norm(c) === 'IT')
console.log('\n=== 2. DE eBay rows in full ===')
console.log('DE rows:', de.length, ' IT rows:', it.length)
for (const c of de) {
  console.log(
    `  id=${c.id} sku=${c.product?.sku} prodDeleted=${c.product?.deletedAt ? 'YES' : 'no'} ` +
      `mp=${c.marketplace} cm=${c.channelMarket} region=${c.region} ` +
      `itemId=${c.externalListingId ?? '(none)'} parent=${c.externalParentId ?? '-'} ppid=${c.platformProductId ?? '-'} ` +
      `status=${c.listingStatus} pub=${c.isPublished} offerActive=${c.offerActive} paused=${c.syncPaused} ` +
      `qty=${c.quantity} price=${c.price} created=${c.createdAt.toISOString().slice(0, 10)} updated=${c.updatedAt.toISOString().slice(0, 10)}`,
  )
}

// ── 3. do the DE products ALSO have IT rows? ──────────────────────────────
console.log('\n=== 3. DE products that ALSO have an IT eBay row (the multi-market 12) ===')
const itByProduct = new Map(it.map((c) => [c.productId, c]))
let alsoIt = 0
for (const c of de) {
  const itRow = itByProduct.get(c.productId)
  if (itRow) {
    alsoIt++
    console.log(`  ${c.product?.sku}: DE(${c.id}, item=${c.externalListingId ?? 'none'})  IT(${itRow.id}, item=${itRow.externalListingId ?? 'none'}, status=${itRow.listingStatus})`)
  } else {
    console.log(`  ${c.product?.sku}: DE(${c.id}, item=${c.externalListingId ?? 'none'})  IT(-- none --)`)
  }
}
console.log('DE rows whose product also has an IT row:', alsoIt, '/', de.length)

// ── 4. F6: externalListingId collisions across markets ────────────────────
console.log('\n=== 4. F6 — externalListingId shared across MARKETS (cross-market ItemID collision) ===')
const byItem = new Map<string, typeof all>()
for (const c of all) {
  if (!c.externalListingId) continue
  const arr = byItem.get(c.externalListingId) ?? []
  arr.push(c)
  byItem.set(c.externalListingId, arr)
}
let collisions = 0
for (const [item, rows] of byItem) {
  const mkts = new Set(rows.map(norm))
  if (rows.length > 1) {
    collisions++
    console.log(`  ItemID ${item} appears on ${rows.length} rows, markets=${J([...mkts])}`)
    for (const r of rows) console.log(`      - clId=${r.id} mkt=${norm(r)} sku=${r.product?.sku} status=${r.listingStatus} pub=${r.isPublished} qty=${r.quantity}`)
  }
}
console.log('collision groups:', collisions)

console.log('\n=== 4b. targeted probe: ItemID 257584954808 ===')
const probe = await prisma.channelListing.findMany({
  where: { externalListingId: '257584954808' },
  select: { id: true, channel: true, marketplace: true, channelMarket: true, region: true, listingStatus: true, isPublished: true, quantity: true, price: true, createdAt: true, updatedAt: true, product: { select: { sku: true, name: true, deletedAt: true } } },
})
console.log('rows with that ItemID:', probe.length)
for (const r of probe) console.log('   ', J(r))
const probeMem = await prisma.sharedListingMembership.findMany({ where: { itemId: '257584954808' }, select: { id: true, marketplace: true, sku: true, parentSku: true, status: true, productId: true, price: true, followPool: true } })
console.log('SharedListingMembership rows for that ItemID:', probeMem.length, ' markets=', J([...new Set(probeMem.map((m) => m.marketplace))]), ' statuses=', J([...new Set(probeMem.map((m) => m.status))]))

// ── 5. dependents of the DE rows ──────────────────────────────────────────
const deIds = de.map((c) => c.id)
const deProductIds = [...new Set(de.map((c) => c.productId))]
const deItemIds = de.map((c) => c.externalListingId).filter((x): x is string => !!x)
console.log('\n=== 5. dependents of the DE ChannelListing rows ===')
console.log('deIds:', deIds.length, ' deProductIds:', deProductIds.length, ' deItemIds:', J(deItemIds))

const [offers, images, obq, overrides, syncAttempts, suppressions, listingIssues, watcher, markdowns, priceHist, promoHist] = await Promise.all([
  prisma.offer.count({ where: { channelListingId: { in: deIds } } }),
  prisma.channelListingImage.count({ where: { channelListingId: { in: deIds } } }),
  prisma.outboundSyncQueue.findMany({ where: { channelListingId: { in: deIds } }, select: { id: true, syncStatus: true, syncType: true, targetChannel: true, targetRegion: true, externalListingId: true } }),
  prisma.channelListingOverride.count({ where: { channelListingId: { in: deIds } } }),
  prisma.syncAttempt.count({ where: { listingId: { in: deIds } } }).catch(() => -1),
  prisma.amazonSuppression.count({ where: { listingId: { in: deIds } } }).catch(() => -1),
  prisma.listingIssue.count({ where: { listingId: { in: deIds } } }).catch(() => -1),
  prisma.ebayWatcherStats.count({ where: { channelListingId: { in: deIds } } }).catch(() => -1),
  prisma.ebayMarkdown.count({ where: { channelListingId: { in: deIds } } }).catch(() => -1),
  prisma.channelListing.count({ where: { id: { in: deIds } } }),
  Promise.resolve(0),
])
console.log('Offer:', offers, '| ChannelListingImage:', images, '| OutboundSyncQueue:', obq.length, '| ChannelListingOverride:', overrides)
console.log('SyncAttempt:', syncAttempts, '| AmazonSuppression:', suppressions, '| ListingIssue:', listingIssues, '| EbayWatcherStats:', watcher, '| EbayMarkdown:', markdowns, '| (sanity DE row count):', priceHist, promoHist)
if (obq.length) for (const q of obq) console.log('    OBQ', J(q))

// SharedListingMembership: by marketplace + by the DE itemIds
console.log('\n=== 5b. SharedListingMembership by marketplace ===')
const memAll = await prisma.sharedListingMembership.groupBy({ by: ['marketplace', 'status'], _count: { _all: true } })
console.log(J(memAll))
const memDE = await prisma.sharedListingMembership.findMany({ where: { marketplace: 'DE' }, select: { id: true, sku: true, itemId: true, parentSku: true, status: true, productId: true, price: true, followPool: true, lastQtyPushed: true } })
console.log('DE memberships:', memDE.length)
for (const m of memDE) console.log('   ', J(m))
if (deItemIds.length) {
  const memByItem = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: deItemIds } }, select: { id: true, marketplace: true, sku: true, itemId: true, status: true, productId: true } })
  console.log('memberships matching a DE row ItemID (ANY market):', memByItem.length)
  for (const m of memByItem.slice(0, 40)) console.log('   ', J(m))
}

// ChannelLiveImage + ChannelImagePublishJob are product-scoped, not listing-scoped
console.log('\n=== 5c. product-scoped tables (NOT cascaded by ChannelListing delete) ===')
const cliDE = await prisma.channelLiveImage.count({ where: { productId: { in: deProductIds }, channel: 'EBAY', marketplace: 'DE' } })
const cliAny = await prisma.channelLiveImage.count({ where: { productId: { in: deProductIds }, channel: 'EBAY' } })
const cipj = await prisma.channelImagePublishJob.count({ where: { productId: { in: deProductIds }, channel: 'EBAY' } })
const cipjDE = await prisma.channelImagePublishJob.count({ where: { productId: { in: deProductIds }, channel: 'EBAY', marketplace: 'DE' } })
console.log('ChannelLiveImage (EBAY, these products): total', cliAny, ' marketplace=DE:', cliDE)
console.log('ChannelImagePublishJob (EBAY, these products): total', cipj, ' marketplace=DE:', cipjDE)

// ── 6. baseline for the "IT untouched" proof ──────────────────────────────
console.log('\n=== 6. IT BASELINE (must be byte-identical after the delete) ===')
const itLive = it.filter((c) => c.externalListingId)
console.log('IT eBay rows total:', it.length, ' with ItemID:', itLive.length)
const itItemIds = [...new Set(itLive.map((c) => c.externalListingId!))].sort()
console.log('distinct IT ItemIDs:', itItemIds.length)
const crypto = await import('node:crypto')
console.log('SHA256(sorted IT ItemIDs):', crypto.createHash('sha256').update(itItemIds.join(',')).digest('hex'))
const itMemCount = await prisma.sharedListingMembership.count({ where: { marketplace: 'IT' } })
const itMemActive = await prisma.sharedListingMembership.count({ where: { marketplace: 'IT', status: 'ACTIVE' } })
console.log('IT memberships:', itMemCount, ' ACTIVE:', itMemActive)
const itMemItems = await prisma.sharedListingMembership.findMany({ where: { marketplace: 'IT' }, select: { itemId: true }, distinct: ['itemId'] })
console.log('distinct IT membership ItemIDs:', itMemItems.length)
console.log('SHA256(sorted IT membership ItemIDs):', crypto.createHash('sha256').update(itMemItems.map((m) => m.itemId).sort().join(',')).digest('hex'))

// ── 7. do the DE products share stock / are they parents of live IT rows? ─
console.log('\n=== 7. DE products: any other channel rows, and are they variation parents? ===')
for (const pid of deProductIds) {
  const rows = await prisma.channelListing.findMany({ where: { productId: pid }, select: { channel: true, marketplace: true, region: true, listingStatus: true, externalListingId: true } })
  const kids = await prisma.product.count({ where: { parentId: pid } })
  const prod = de.find((c) => c.productId === pid)?.product
  console.log(`  ${prod?.sku} (${pid}) children=${kids} rows=${J(rows.map((r) => `${r.channel}/${r.marketplace || r.region}:${r.listingStatus}:${r.externalListingId ?? '-'}`))}`)
}

await prisma.$disconnect()
