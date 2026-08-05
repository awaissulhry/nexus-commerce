/* READ-ONLY: does any FOLDED member master carry warehouse stock? + detail-page reachability */
const { default: prisma } = await import('../src/db.js')

// masters that are childless duplicates (from probe 1 output) — re-derive generically
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, quantity: true, product: { select: { sku: true, parentId: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const pids = [...new Set([...listings.map((l) => l.productId), ...mems.map((m) => m.productId).filter(Boolean) as string[]])]
const prods = await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, sku: true, parentId: true } })
const masterIds = [...new Set(prods.map((p) => p.parentId ?? p.id))]
const kids = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const withKids = new Set(kids.map((k) => k.parentId!))
const childless = masterIds.filter((m) => !withKids.has(m))
const skuOf = new Map((await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })).map((p) => [p.id, p.sku]))

const lv = await prisma.stockLevel.findMany({
  where: { productId: { in: masterIds }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, quantity: true, location: { select: { code: true } } },
})
const byP = new Map<string, { avail: number; det: string[] }>()
for (const l of lv) {
  const e = byP.get(l.productId) ?? { avail: 0, det: [] }
  e.avail += l.available; e.det.push(`${l.location?.code}:${l.available}`)
  byP.set(l.productId, e)
}
console.log('=== MASTER products that themselves carry WAREHOUSE stock ===')
for (const [pid, e] of byP) {
  if (e.avail === 0) continue
  console.log(`  ${skuOf.get(pid)} (${withKids.has(pid) ? 'CANONICAL/has children' : 'CHILDLESS duplicate'}) avail=${e.avail} [${e.det.join(', ')}]`)
}
console.log('')
console.log('=== childless duplicate masters (fold sources) ===')
console.log('  ' + childless.map((c) => skuOf.get(c)).sort().join(', '))
console.log('')
console.log('=== listing rows whose productId is a MASTER (these become fake "variants") ===')
const cnt = new Map<string, number>()
for (const l of listings) {
  if (l.product?.parentId) continue
  cnt.set(l.product?.sku ?? '?', (cnt.get(l.product?.sku ?? '?') ?? 0) + 1)
}
for (const [sku, n] of [...cnt].sort((a, b) => b[1] - a[1])) console.log(`  ${sku}: ${n} master-level listing row(s)`)
await prisma.$disconnect()
