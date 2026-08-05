const { default: prisma } = await import('../src/db.js')

const byRegion = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT region, "listingStatus", count(*)::int AS n,
          count(*) FILTER (WHERE coalesce("externalListingId",'') <> '')::int AS with_item_id
   FROM "ChannelListing" WHERE channel='EBAY' GROUP BY 1,2 ORDER BY 1,2`,
)
console.log('EBAY CHANNELLISTING BY REGION/STATUS:', JSON.stringify(byRegion))

const mem = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT marketplace, count(*)::int AS n FROM "SharedListingMembership" GROUP BY 1 ORDER BY 1`,
)
console.log('SHARED MEMBERSHIPS BY MARKETPLACE:', JSON.stringify(mem))

// per-market axis name label overrides (the only per-market rename hook)
const labels = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT cl.marketplace, count(*)::int AS n
   FROM "ChannelListing" cl
   WHERE cl.channel='EBAY' AND cl."platformAttributes" ? '_axisNameLabels'
     AND cl."platformAttributes"->'_axisNameLabels' <> '{}'::jsonb
   GROUP BY 1 ORDER BY 1`,
)
console.log('LISTINGS WITH NON-EMPTY _axisNameLabels:', JSON.stringify(labels))

await prisma.$disconnect()
