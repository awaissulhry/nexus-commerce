import { PrismaClient } from '@prisma/client'
const url = process.argv[2]
const p = new PrismaClient({ datasources: { db: { url } } })
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const out: any = { db: url.includes('neon') ? 'NEON-PROD' : 'LOCAL-DOCKER' }

// 1. every non-null variationMapping in the table, with its shape
const vm = await p.channelListing.findMany({
  where: { OR: [{ NOT: { variationMapping: { equals: null } } }, { NOT: { variationTheme: null } }] },
  select: { id: true, productId: true, channel: true, marketplace: true, aliasKey: true, variationTheme: true, variationMapping: true },
})
out.variationRows = vm.length
out.shapes = vm.map(r => {
  const m = r.variationMapping as any
  const kinds = m && typeof m === 'object' && !Array.isArray(m)
    ? Object.entries(m).map(([k, v]) => `${k}:${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}`)
    : m === null ? ['<null>'] : [typeof m]
  return { ch: `${r.channel}/${r.marketplace}`, prod: r.productId.slice(-6), theme: r.variationTheme, kinds }
})

// 2. legacy alias indexes
const idx = await p.$queryRawUnsafe<any[]>(`SELECT indexname FROM pg_indexes WHERE tablename='ChannelListing' AND indexname LIKE '%productId_channel%' ORDER BY indexname`)
out.channelListingIndexes = idx.map(r => r.indexname)
out.aliasRows = await p.productListingAlias.count()

// 3. GALE family + its listings
const parent = await p.product.findUnique({ where: { id: GALE }, select: { id: true, sku: true, name: true, version: true, variationAxes: true, productType: true, familyId: true, status: true } })
const kids = await p.product.findMany({ where: { parentId: GALE, deletedAt: null }, select: { id: true, sku: true, status: true, categoryAttributes: true }, orderBy: { sku: 'asc' } })
out.parent = parent
out.childCount = kids.length
out.childAxisSample = kids.slice(0, 4).map(k => ({ sku: k.sku, status: k.status, axisVals: Object.fromEntries(Object.entries((k.categoryAttributes ?? {}) as any).filter(([kk]) => /colore|taglia/i.test(kk))) }))
const ids = [GALE, ...kids.map(k => k.id)]
const listings = await p.channelListing.groupBy({ by: ['channel', 'marketplace', 'channelConnectionId', 'aliasKey', 'listingStatus', 'isPublished'], where: { productId: { in: ids } }, _count: { _all: true } })
out.galeListings = listings.map(l => ({ coord: `${l.channel}/${l.marketplace}`, conn: (l.channelConnectionId ?? 'NULL').slice(-6), alias: l.aliasKey || '(primary)', status: l.listingStatus, pub: l.isPublished, n: l._count._all }))
const parentRows = await p.channelListing.findMany({ where: { productId: GALE }, select: { channel: true, marketplace: true, aliasKey: true, variationTheme: true, variationMapping: true, externalListingId: true, externalParentId: true, listingStatus: true, version: true } })
out.galeParentListings = parentRows
console.log(JSON.stringify(out, null, 1))
await p.$disconnect()
