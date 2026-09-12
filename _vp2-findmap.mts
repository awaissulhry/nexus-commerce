import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const rows: any[] = await p.$queryRawUnsafe(
 `SELECT id, "productId", channel, marketplace, "aliasKey", "variationTheme", "variationMapping", version, "updatedAt"
    FROM "ChannelListing" WHERE "variationMapping" IS NOT NULL`)
for (const r of rows) console.log(JSON.stringify(r))
const skus = await p.product.findMany({ where: { id: { in: rows.map(r => r.productId) } }, select: { id: true, sku: true } })
console.log('products:', JSON.stringify(skus))
await p.$disconnect()
