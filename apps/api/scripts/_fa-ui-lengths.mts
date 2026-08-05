import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// Longest child-row label = sku + " #" + itemId (per-product page sticky col, width 280)
const memb = await prisma.$queryRawUnsafe<any[]>(`
  SELECT m.sku, m."itemId", length(m.sku) AS sl, length(m.sku)+length(m."itemId")+2 AS total
  FROM "SharedListingMembership" m
  ORDER BY total DESC LIMIT 8
`)
console.log('TOP shared-membership label lengths (sku + #itemId):')
for (const r of memb) console.log(`  ${r.total}  ${r.sku} #${r.itemId}`)

const cl = await prisma.$queryRawUnsafe<any[]>(`
  SELECT DISTINCT p.sku, length(p.sku) AS sl
  FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
  ORDER BY sl DESC LIMIT 8
`)
console.log('\nTOP listing SKU lengths:')
for (const r of cl) console.log(`  ${r.sl}  ${r.sku}`)

// how many rows would the biggest per-product page have?
const big = await prisma.$queryRawUnsafe<any[]>(`
  SELECT parent.sku AS parent_sku, count(*) AS n
  FROM "Product" c JOIN "Product" parent ON parent.id = c."parentId"
  GROUP BY parent.sku ORDER BY n DESC LIMIT 6
`)
console.log('\nBiggest families (variant counts):')
for (const r of big) console.log(`  ${r.n}  ${r.parent_sku}`)

// product names (Product column truncation)
const nm = await prisma.$queryRawUnsafe<any[]>(`
  SELECT sku, name, length(name) AS n FROM "Product" WHERE "parentId" IS NULL ORDER BY n DESC LIMIT 5
`)
console.log('\nLongest master names:')
for (const r of nm) console.log(`  ${r.n}  ${r.sku} :: ${r.name}`)

await prisma.$disconnect()
