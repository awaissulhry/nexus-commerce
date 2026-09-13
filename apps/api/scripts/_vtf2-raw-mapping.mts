import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'; import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const rows = await prisma.channelListing.findMany({
  where: { product: { sku: { startsWith: 'VTF2-TEST' } } },
  select: { id: true, channel: true, marketplace: true, version: true, variationTheme: true, variationMapping: true, product: { select: { sku: true } } },
  orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
})
for (const r of rows.filter(r => r.variationMapping !== null || r.variationTheme !== null)) {
  console.log(`${r.product.sku} ${r.channel}·${r.marketplace} v${r.version} theme=${JSON.stringify(r.variationTheme)} mapping=${JSON.stringify(r.variationMapping)}`)
}
const shapes = await prisma.$queryRawUnsafe<Array<{ shape: string; n: bigint }>>(`
  SELECT CASE WHEN "variationMapping" IS NULL THEN 'null'
              WHEN jsonb_typeof(("variationMapping"::jsonb) -> 'axes') = 'array' THEN 'ordered'
              ELSE 'flat' END AS shape, COUNT(*)::bigint AS n FROM "ChannelListing" GROUP BY 1 ORDER BY 2 DESC`)
console.log('SHAPES NOW:', JSON.stringify(shapes.map(r => [r.shape, Number(r.n)])))
await prisma.$disconnect()
