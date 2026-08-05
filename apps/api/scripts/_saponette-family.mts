/** READ-ONLY: knee-slider family + cron evidence + live variation SKUs. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const slid = await prisma.product.findMany({
  where: { sku: { contains: 'knee-slider' }, deletedAt: null },
  select: { sku: true, productType: true, parentId: true, _count: { select: { children: true } } },
  orderBy: { sku: 'asc' },
})
for (const p of slid) console.log(`PRODUCT ${p.sku}: type=${p.productType} children=${p._count.children} isChild=${!!p.parentId}`)
const mems = await prisma.sharedListingMembership.findMany({
  where: { parentSku: { contains: 'knee-slider' } },
  select: { parentSku: true, itemId: true }, distinct: ['parentSku', 'itemId'],
})
console.log('MEMBERSHIP groups:', JSON.stringify(mems))
const clAll = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', product: { sku: { contains: 'knee-slider' }, deletedAt: null } },
  select: { externalListingId: true, marketplace: true, product: { select: { sku: true } } },
})
console.log('CLs:', JSON.stringify(clAll.map((c) => `${c.product?.sku}@${c.marketplace}=${c.externalListingId ?? 'null'}`)))
const cron = await prisma.cronRun.findMany({ where: { job: { contains: 'label' } }, orderBy: { startedAt: 'desc' }, take: 3,
  select: { job: true, startedAt: true, status: true, summary: true } }).catch(() => [])
console.log('CRON RUNS:', JSON.stringify(cron).slice(0, 400))
// live variations of the Saponette listing
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>256566112769</ItemID></GetItemRequest>`, { oauthToken: token, siteId: siteIdForMarket('IT') })
const varBlocks = [...got.raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)]
const withSku = varBlocks.filter((m) => /<SKU>[^<]+<\/SKU>/.test(m[1]))
const axes = [...(/<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/.exec(got.raw)?.[1] ?? '').matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1])
console.log(`LIVE 256566112769: variations=${varBlocks.length} withSku=${withSku.length} axes=${JSON.stringify(axes)}`)
console.log('  sample skus:', withSku.slice(0, 4).map((m) => /<SKU>([^<]+)<\/SKU>/.exec(m[1])?.[1]).join(', ') || '(none)')
await prisma.$disconnect()
