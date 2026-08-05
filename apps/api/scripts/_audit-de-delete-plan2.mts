/** READ-ONLY follow-up: the delist vectors + non-FK references + pending queue state. */
const { default: prisma } = await import('../src/db.js')
const J = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))

const de = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', marketplace: 'DE' },
  select: { id: true, productId: true, externalListingId: true, listingStatus: true, product: { select: { sku: true, parentId: true, ebayItemId: true, categoryAttributes: true } } },
})
const deIds = de.map((c) => c.id)
const deProductIds = de.map((c) => c.productId)

console.log('=== A. DELIST VECTOR 1: Product.ebayItemId on the 12 DE products ===')
for (const c of de) {
  const p = c.product
  console.log(`  ${p?.sku}  clExternalId=${JSON.stringify(c.externalListingId)}  Product.ebayItemId=${JSON.stringify(p?.ebayItemId)}  parentId=${p?.parentId ?? '-'}`)
}

console.log('\n=== A2. do those ebayItemIds belong to LIVE IT listings? ===')
const ids = [...new Set(de.flatMap((c) => [c.externalListingId, c.product?.ebayItemId]).filter((x): x is string => !!x))]
console.log('candidate delist ItemIDs:', J(ids))
for (const iid of ids) {
  const itRows = await prisma.channelListing.count({ where: { channel: 'EBAY', marketplace: 'IT', externalListingId: iid } })
  const mem = await prisma.sharedListingMembership.count({ where: { itemId: iid, status: 'ACTIVE' } })
  console.log(`  ItemID ${iid}: IT ChannelListing rows=${itRows}  ACTIVE memberships=${mem}`)
}

console.log('\n=== A3. parent chain of the DE products (is a UI delete a "variation child"?) ===')
for (const c of de) {
  const parent = c.product?.parentId ? await prisma.product.findUnique({ where: { id: c.product.parentId }, select: { sku: true, ebayItemId: true } }) : null
  console.log(`  ${c.product?.sku}: parentSku=${parent?.sku ?? '(none — standalone/parent row)'} parentEbayItemId=${parent?.ebayItemId ?? '-'}`)
}

console.log('\n=== B. OutboundSyncQueue state for these listings (any live/pending work?) ===')
const q = await prisma.outboundSyncQueue.groupBy({ by: ['syncStatus', 'syncType'], where: { channelListingId: { in: deIds } }, _count: { _all: true } })
console.log(J(q))
const pending = await prisma.outboundSyncQueue.count({ where: { channelListingId: { in: deIds }, syncStatus: { in: ['PENDING', 'IN_PROGRESS'] } } })
console.log('PENDING/PROCESSING/RETRYING for DE listings:', pending)
// OBQ rows that reference DE by region but NOT by channelListingId (would NOT cascade)
const byRegion = await prisma.outboundSyncQueue.count({ where: { targetChannel: 'EBAY', targetRegion: 'DE' } })
const byRegionNoCl = await prisma.outboundSyncQueue.count({ where: { targetChannel: 'EBAY', targetRegion: 'DE', channelListingId: null } })
console.log('OBQ EBAY/DE total:', byRegion, ' of which channelListingId=null (survives cascade):', byRegionNoCl)
const orphanRisk = await prisma.outboundSyncQueue.findMany({
  where: { targetChannel: 'EBAY', targetRegion: 'DE', channelListingId: null, syncStatus: { in: ['PENDING', 'IN_PROGRESS'] } },
  select: { id: true, syncStatus: true, syncType: true, externalListingId: true, productId: true, holdUntil: true },
})
console.log('  DE queue rows with NO channelListingId that are still actionable:', orphanRisk.length, J(orphanRisk.slice(0, 10)))

console.log('\n=== C. non-FK references to these ChannelListing ids (orphan after delete, no cascade) ===')
const audit = await prisma.syncControlAudit.count({ where: { scopeType: 'LISTING', scopeId: { in: deIds } } }).catch((e) => `ERR ${e.message}`)
console.log('SyncControlAudit(scopeType=LISTING, scopeId in DE ids):', audit)
const chgAudit = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT count(*)::bigint AS n FROM "ChangeAudit" WHERE "entityType" = 'ChannelListing' AND "entityId" = ANY($1::text[])`, deIds,
).catch((e) => [{ n: BigInt(-1) }] as any)
console.log('ChangeAudit(entityType=ChannelListing):', Number(chgAudit[0]?.n ?? -1))

console.log('\n=== D. stock / ledger coupling ===')
const sl = await prisma.stockLevel.count({ where: { productId: { in: deProductIds } } }).catch(() => -1)
console.log('StockLevel rows for these products (product-scoped, NOT touched by a ChannelListing delete):', sl)
const cse = await prisma.channelStockEvent.count({ where: { channel: 'EBAY', productId: { in: deProductIds } } }).catch(() => -1)
console.log('ChannelStockEvent (EBAY, these products) — productId FK is SetNull, unrelated to ChannelListing:', cse)

console.log('\n=== E. ebayFileExcluded stamp — is it already present, and is the read path market-scoped? ===')
for (const c of de) {
  const ca = c.product?.categoryAttributes as Record<string, unknown> | null
  const excl = ca && typeof ca === 'object' ? (ca as any).ebayFileExcluded : undefined
  if (excl) console.log(`  ${c.product?.sku}: ebayFileExcluded=${J(excl)}`)
}
console.log('(blank above = no product currently carries the stamp)')

console.log('\n=== F. ItemID 257584954808 — where does it live besides ChannelListing? ===')
for (const t of ['SharedListingMembership', 'OutboundSyncQueue', 'ChannelImagePublishJob']) {
  // generic probe via raw SQL on the obvious columns
}
const memIT = await prisma.sharedListingMembership.count({ where: { itemId: '257584954808' } })
const obqItem = await prisma.outboundSyncQueue.count({ where: { externalListingId: '257584954808' } })
const obqItemDE = await prisma.outboundSyncQueue.count({ where: { externalListingId: '257584954808', targetRegion: 'DE' } })
console.log('memberships:', memIT, ' OBQ rows:', obqItem, ' of which targetRegion=DE:', obqItemDE)

console.log('\n=== G. eBay write gate state (would a delist actually reach eBay?) ===')
console.log('NEXUS_EBAY_REAL_API =', JSON.stringify(process.env.NEXUS_EBAY_REAL_API), ' NODE_ENV =', JSON.stringify(process.env.NODE_ENV), ' EBAY_SANDBOX =', JSON.stringify(process.env.EBAY_SANDBOX))
const conn = await prisma.channelConnection.findMany({ where: { channelType: 'EBAY' }, select: { id: true, isActive: true, accountName: true } }).catch(() => [])
console.log('eBay connections:', J(conn))

await prisma.$disconnect()
