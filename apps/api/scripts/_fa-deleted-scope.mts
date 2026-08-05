/** READ-ONLY: how many Sync Control rows belong to DELETED products?
 *  And does the sync ENGINE also see them (i.e. could it push a deleted product)? */
const { default: prisma } = await import('../src/db.js')

// Exactly the computeRows() queries
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, listingStatus: true, product: { select: { sku: true, deletedAt: true, status: true } } },
})
const memsRaw = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, productId: true },
})
const memPids = [...new Set(memsRaw.map((m) => m.productId).filter((x): x is string => Boolean(x)))]
const memProds = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, sku: true, deletedAt: true } })
const prodById = new Map(memProds.map((p) => [p.id, p]))
const mems = memsRaw.map((m) => ({ ...m, product: m.productId ? prodById.get(m.productId) ?? null : null }))

const delListings = listings.filter((l) => l.product?.deletedAt)
const delMems = mems.filter((m) => m.product?.deletedAt)
console.log(`SYNC CONTROL scope:`)
console.log(`  channelListing rows: ${listings.length}  of which DELETED product: ${delListings.length}`)
console.log(`  membership rows:     ${mems.length}  of which DELETED product: ${delMems.length}`)

const bySku = new Map<string, number>()
for (const l of delListings) bySku.set(l.product!.sku, (bySku.get(l.product!.sku) ?? 0) + 1)
for (const m of delMems) bySku.set(m.product!.sku, (bySku.get(m.product!.sku) ?? 0) + 1)
console.log(`  deleted products appearing: ${bySku.size}`)
for (const [sku, n] of [...bySku.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${sku}: ${n} row(s)`)

// listingStatus distribution of the deleted ones (are they DRAFT-only or live?)
const byStatus = new Map<string, number>()
for (const l of delListings) byStatus.set(l.listingStatus, (byStatus.get(l.listingStatus) ?? 0) + 1)
console.log(`  deleted-product listing statuses: ${JSON.stringify(Object.fromEntries(byStatus))}`)

// Does the ENGINE (cascade) also include deleted products? cascade reads ChannelListing by productId.
const anyDeletedWithStock = await prisma.stockLevel.count({
  where: { product: { deletedAt: { not: null } }, available: { gt: 0 } },
})
console.log(`\nENGINE RISK: stock rows on DELETED products with available>0: ${anyDeletedWithStock}`)

// Also: DRAFT listings in the sync-control scope overall (should a draft be controllable?)
const draft = listings.filter((l) => l.listingStatus === 'DRAFT')
console.log(`DRAFT listings inside sync-control scope: ${draft.length} (of ${listings.length})`)
await prisma.$disconnect()
