/** READ-ONLY: per-market FBM offer-closure lists for Seller Central (or the
 *  future in-app close action). FBA offers excluded — Amazon ships those, so
 *  the cross-border shipping cost problem doesn't apply. */
const { default: prisma } = await import('../src/db.js')
import { writeFileSync } from 'node:fs'
const OUT = '/private/tmp/claude-501/-Users-awais-nexus-commerce/9c5fbc56-8b89-4a23-9801-2fc73a2033a3/scratchpad'
for (const mkt of ['DE', 'FR', 'ES']) {
  const rows = await prisma.channelListing.findMany({
    where: {
      channel: 'AMAZON', marketplace: mkt, isPublished: true,
      listingStatus: { notIn: ['ENDED', 'REMOVED', 'DRAFT'] },
      product: { deletedAt: null },
    },
    select: { externalListingId: true, quantity: true, fulfillmentMethod: true, product: { select: { sku: true, name: true, fulfillmentMethod: true } } },
  })
  const fbm = rows.filter((r) => r.fulfillmentMethod !== 'FBA' && r.product?.fulfillmentMethod !== 'FBA')
  const csv = ['sku,asin,name'].concat(
    fbm.map((r) => `${r.product?.sku},${r.externalListingId ?? ''},"${(r.product?.name ?? '').replace(/"/g, "'").slice(0, 60)}"`),
  ).join('\n')
  writeFileSync(`${OUT}/amazon-${mkt}-fbm-offers-to-close.csv`, csv)
  console.log(`${mkt}: ${fbm.length} FBM offers (FBA excluded: ${rows.length - fbm.length}) → amazon-${mkt}-fbm-offers-to-close.csv`)
}
await prisma.$disconnect()
