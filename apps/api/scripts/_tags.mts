import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const n = (_k: string, v: unknown) => (typeof v === 'bigint' ? Number(v) : v)

const tags = await q(`
  SELECT t.name, t.color, COUNT(pt."productId")::int AS products
  FROM "Tag" t LEFT JOIN "ProductTag" pt ON pt."tagId" = t.id
  GROUP BY t.id, t.name, t.color ORDER BY products DESC, t.name LIMIT 20`)
const totals = await q(`
  SELECT (SELECT COUNT(*)::int FROM "Tag") AS tags,
         (SELECT COUNT(*)::int FROM "ProductTag") AS product_tag_links,
         (SELECT COUNT(DISTINCT "productId")::int FROM "ProductTag") AS tagged_products,
         (SELECT COUNT(*)::int FROM "Tag" WHERE color IS NULL) AS tags_without_colour,
         (SELECT COUNT(*)::int FROM "OrderTag") AS order_tag_links,
         (SELECT COUNT(*)::int FROM "AssetTag") AS asset_tag_links`)
// would tagging a parent leave its children untagged today?
const family = await q(`
  SELECT COUNT(*)::int AS tagged_parents,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM "Product" c WHERE c."parentId" = p.id) THEN 1 ELSE 0 END)::int AS with_children
  FROM "ProductTag" pt JOIN "Product" p ON p.id = pt."productId" WHERE p."parentId" IS NULL`)
console.log(JSON.stringify({ totals: totals[0], familyImpact: family[0], tags }, n, 1))
await prisma.$disconnect()
