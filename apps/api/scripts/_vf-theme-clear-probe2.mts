import { default as prisma } from '../src/db.js'

const agg = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT count(*) AS ebay_listings,
         count(*) FILTER (WHERE cl."platformAttributes" ? '_variationAxes') AS with_stored_axes
  FROM "ChannelListing" cl WHERE cl.channel = 'EBAY'
`)
console.log('AGG', JSON.stringify(agg, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))

const themed = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT count(*) AS parents_with_theme
  FROM "Product" p
  WHERE p."deletedAt" IS NULL AND p."parentId" IS NULL
    AND p."variationTheme" IS NOT NULL AND p."variationTheme" <> ''
`)
console.log('THEMED', JSON.stringify(themed, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
await prisma.$disconnect()
