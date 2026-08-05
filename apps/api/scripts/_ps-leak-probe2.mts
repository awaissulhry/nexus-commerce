/** READ-ONLY part 2: ASIN availability + what an Amazon-scoped picker should show. */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

L('══ Product.amazonAsin COVERAGE ═══════════════════════════════════')
const prodTotal = await p.product.count({ where: { deletedAt: null } })
const withAsin = await p.product.count({ where: { deletedAt: null, amazonAsin: { not: null } } })
L(`  products (not deleted): ${prodTotal}`)
L(`  with amazonAsin set:    ${withAsin}  (${((withAsin / prodTotal) * 100).toFixed(1)}%)`)

L('\n══ ADVERTISABLE UNIT = the CHILD, per marketplace ════════════════')
for (const mk of ['IT', 'DE', 'FR', 'ES']) {
  const live = await p.channelListing.count({
    where: { channel: 'AMAZON', marketplace: mk, isPublished: true, listingStatus: 'ACTIVE' },
  })
  const all = await p.channelListing.count({ where: { channel: 'AMAZON', marketplace: mk } })
  L(`  AMAZON_${mk}: ${String(live).padStart(4)} live+active of ${String(all).padStart(4)} listing rows`)
}

L('\n══ WHAT THE PICKER SHOULD OFFER for a campaign on AMAZON_IT ══════')
const itRoots = await p.productReadCache.count({
  where: { deletedAt: null, parentId: null, channelKeys: { hasSome: ['AMAZON_IT'] } },
})
const itAll = await p.productReadCache.count({
  where: { deletedAt: null, channelKeys: { hasSome: ['AMAZON_IT'] } },
})
L(`  top-level families/standalones on AMAZON_IT: ${itRoots}   (vs 37 shown today)`)
L(`  incl. children on AMAZON_IT:                 ${itAll}`)

L('\n══ CHILDREN: does a family root carry its own Amazon key? ════════')
const roots = await p.productReadCache.findMany({
  where: { deletedAt: null, parentId: null, childCount: { gt: 0 } },
  select: { id: true, sku: true, childCount: true, channelKeys: true },
  orderBy: { sku: 'asc' },
})
for (const r of roots) {
  const kidsOnAmz = await p.productReadCache.count({
    where: { deletedAt: null, parentId: r.id, channelKeys: { hasSome: ['AMAZON_IT', 'AMAZON_DE', 'AMAZON_FR', 'AMAZON_ES'] } },
  })
  L(`  ${String(r.sku).padEnd(26)} children=${String(r.childCount).padStart(3)}  onAmazon=${String(kidsOnAmz).padStart(3)}  rootKeys=[${r.channelKeys.join(',') || '—'}]`)
}

L('\n══ FBA vs FBM split (ads care: only buyable offers) ══════════════')
const byFm = await p.$queryRawUnsafe(
  `SELECT "fulfillmentMethod"::text AS fm, COUNT(*)::int AS n FROM "ChannelListing" WHERE channel='AMAZON' GROUP BY 1 ORDER BY 2 DESC`,
)
for (const r of byFm as any[]) L(`  fulfillmentMethod=${String(r.fm)}  ${r.n}`)

L('\n══ SB / product-target impact: ASIN required, picker sends "" ════')
const sbNeed = await p.adProductAd.count({ where: { adType: 'BRAND_AD' } })
L(`  existing BRAND_AD rows: ${sbNeed}`)
L('  createSbAdLocal throws "at least one ASIN required" on empty asin[]')
L('  SingleCampaignBuilder sends p.asin || p.sku  → a SKU where Amazon wants an ASIN')

await prisma.$disconnect()
