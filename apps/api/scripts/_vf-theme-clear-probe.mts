import { default as prisma } from '../src/db.js'

const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT p.sku,
         p."variationTheme" AS product_theme,
         cl.region,
         cl."flatFileSnapshot"->>'variation_theme' AS snap_theme,
         (cl."flatFileSnapshot" ? 'variation_theme') AS snap_has_key
  FROM "Product" p
  JOIN "ChannelListing" cl ON cl."productId" = p.id AND cl.channel = 'EBAY'
  WHERE p."deletedAt" IS NULL
    AND p."parentId" IS NULL
    AND cl."flatFileSnapshot" IS NOT NULL
  ORDER BY p.sku
  LIMIT 40
`)
console.log(JSON.stringify(rows, null, 1))

const agg = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT count(*) FILTER (WHERE cl."flatFileSnapshot" ? 'variation_theme') AS with_key,
         count(*) FILTER (WHERE cl."flatFileSnapshot"->>'variation_theme' = '') AS empty_val,
         count(*) AS total
  FROM "ChannelListing" cl
  WHERE cl.channel = 'EBAY' AND cl."flatFileSnapshot" IS NOT NULL
`)
console.log('AGG', JSON.stringify(agg, (_k, v) => typeof v === 'bigint' ? Number(v) : v))
await prisma.$disconnect()
