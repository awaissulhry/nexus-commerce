import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const GALE='cmokmy3a40078pm0p1fvnu523'
const r: any[] = await p.$queryRawUnsafe(`SELECT count(*) FILTER (WHERE "variationExcluded")::int AS excluded, count(*) FILTER (WHERE "syncPaused")::int AS paused,
  count(*) FILTER (WHERE "variationMapping" IS NOT NULL)::int AS withMapping, count(*)::int AS total FROM "ChannelListing"`)
console.log('ChannelListing:', JSON.stringify(r[0]), '(all three counters must be 0)')
const prod = await p.product.findUnique({ where: { id: GALE }, select: { version: true, variationTheme: true, variationAxes: true } })
console.log('GALE Product :', JSON.stringify(prod))
console.log('children     :', await p.product.count({ where: { parentId: GALE, deletedAt: null } }), '(20)')
console.log('VP2-REHEARSAL leftovers:', await p.product.count({ where: { sku: { startsWith: 'VP2-REHEARSAL' } } }), '(0)')
const pa = await p.channelListing.findFirst({ where: { productId: GALE, channel: 'EBAY', marketplace: 'IT', aliasKey: '' }, select: { platformAttributes: true } })
console.log('eBay·IT _axisNameLabels present:', '_axisNameLabels' in ((pa!.platformAttributes ?? {}) as object), '(false)')
await p.$disconnect()
