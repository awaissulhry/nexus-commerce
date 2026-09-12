import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const prod = await p.product.findUnique({ where: { id: GALE }, select: { sku: true, variationTheme: true, variationAxes: true, version: true } })
console.log('Product:', JSON.stringify(prod))
const rows = await p.channelListing.findMany({ where: { productId: GALE }, select: { channel: true, marketplace: true, variationTheme: true, variationMapping: true, platformAttributes: true, externalListingId: true, listingStatus: true } })
for (const r of rows) {
  const pa = (r.platformAttributes ?? {}) as Record<string, unknown>
  const axisKeys = Object.keys(pa).filter(k => /axis|variation|lastPublished/i.test(k))
  console.log(`${r.channel}/${r.marketplace} theme=${JSON.stringify(r.variationTheme)} mapping=${JSON.stringify(r.variationMapping)} ext=${r.externalListingId} paKeys=${Object.keys(pa).length}`)
  for (const k of axisKeys) console.log('    ', k, '=', JSON.stringify(pa[k]).slice(0, 300))
}
await p.$disconnect()
