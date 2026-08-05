import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// Reproduce the row set for the GALE group (canonical + folded masters) cheaply:
// take every ChannelListing / membership whose product's master SKU stem is GALE.
const prods = await prisma.product.findMany({
  where: { OR: [{ sku: { contains: 'GALE' } }] },
  select: { id: true, sku: true, parentId: true },
})
const ids = new Set(prods.map((p) => p.id))
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: [...ids] }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, externalListingId: true, syncPaused: true, quantity: true },
})
const skuOf = new Map(prods.map((p) => [p.id, p.sku]))
const mems = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE', productId: { in: [...ids] } },
  select: { itemId: true, marketplace: true, sku: true },
})

const fam = new Map<string, string[]>()
for (const c of cls) {
  const key = `${c.channel}:${c.marketplace}` // itemId never set on LISTING rows
  const a = fam.get(key) ?? []
  a.push(`LISTING ${skuOf.get(c.productId)} (ext=${c.externalListingId ?? 'null'} paused=${c.syncPaused})`)
  fam.set(key, a)
}
for (const m of mems) {
  const key = `EBAY:${m.marketplace}:${m.itemId}`
  const a = fam.get(key) ?? []
  a.push(`SHARED ${m.sku}`)
  fam.set(key, a)
}
for (const [k, v] of [...fam].sort()) {
  console.log(`\nFAMILY ${k}  -> ${v.length} rows`)
  for (const x of v.slice(0, 30)) console.log('   ', x)
  if (v.length > 30) console.log(`    … +${v.length - 30}`)
}
await prisma.$disconnect()
