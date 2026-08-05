/* eslint-disable no-console */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// 1) FOLLOW/PIN/BUFFER re-resolve by (productIds × markets) with only
//    listingStatus != ENDED. computeRows()/the view only shows
//    isPublished=true AND status not in (ENDED, REMOVED).
//    => how many listings would an action touch that are NOT in the view?
const invisible = await prisma.channelListing.findMany({
  where: {
    listingStatus: { not: 'ENDED' },
    OR: [{ isPublished: false }, { listingStatus: 'REMOVED' }],
  },
  select: { id: true, channel: true, marketplace: true, isPublished: true, listingStatus: true, quantity: true, followMasterQuantity: true, product: { select: { sku: true, parentId: true } } },
})
console.log('LISTINGS NOT IN THE VIEW but reachable by setFollowMasterQuantity/setStockBuffer:', invisible.length)
const byCh = new Map<string, number>()
for (const l of invisible) byCh.set(`${l.channel}/${l.marketplace} pub=${l.isPublished} st=${l.listingStatus}`, (byCh.get(`${l.channel}/${l.marketplace} pub=${l.isPublished} st=${l.listingStatus}`) ?? 0) + 1)
for (const [k, v] of [...byCh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('   ', k, v)
console.log('  sample:', invisible.slice(0, 5).map((l) => `${l.product?.sku}@${l.channel}/${l.marketplace}`).join(' | '))

// 2) cross-product over-apply: within one channel, do the SAME products have
//    listings on MULTIPLE marketplaces? (a partial per-row selection on the
//    detail page then also hits the unselected market)
const rows = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, product: { select: { sku: true } } },
})
const marketsByProdCh = new Map<string, Set<string>>()
const skuOf = new Map<string, string>()
for (const r of rows) {
  const k = `${r.productId}|${r.channel}`
  const s = marketsByProdCh.get(k) ?? new Set<string>()
  s.add(r.marketplace); marketsByProdCh.set(k, s)
  skuOf.set(r.productId, r.product?.sku ?? '?')
}
const multi = [...marketsByProdCh.entries()].filter(([, s]) => s.size > 1)
console.log('\nproduct×channel combos on MORE THAN ONE marketplace:', multi.length)
for (const [k, s] of multi.slice(0, 10)) {
  const [pid, ch] = k.split('|')
  console.log('   ', skuOf.get(pid), ch, [...s].join(','))
}

await prisma.$disconnect()
