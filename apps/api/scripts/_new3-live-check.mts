/** READ-ONLY: structural probe for REGAL / WATERPROOF / MISANO cited listings + DB pools. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
for (const id of ['256550346578', '256568112735', '257608449467', '255312097005']) {
  try {
    const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${id}</ItemID></GetItemRequest>`, { oauthToken: token, siteId: siteIdForMarket('IT') })
    const status = /<ListingStatus>([^<]+)<\/ListingStatus>/.exec(got.raw)?.[1] ?? '?'
    const title = /<Title>([^<]{0,50})/.exec(got.raw)?.[1] ?? ''
    const parentSku = /<Item>[\s\S]*?<SKU>([^<]*)<\/SKU>/.exec(got.raw)?.[1] ?? ''
    const varBlocks = [...got.raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)]
    const withSku = varBlocks.filter((m) => /<SKU>[^<]+<\/SKU>/.test(m[1])).length
    const sampleSkus = varBlocks.map((m) => /<SKU>([^<]+)<\/SKU>/.exec(m[1])?.[1] ?? '').filter(Boolean).slice(0, 3)
    const axes = [...(/<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/.exec(got.raw)?.[1] ?? '').matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1])
    console.log(`${id}: status=${status} variations=${varBlocks.length} withSku=${withSku} axes=${JSON.stringify(axes)} itemSku="${parentSku}" title="${title}"`)
    if (sampleSkus.length) console.log(`  sample var SKUs: ${sampleSkus.join(', ')}`)
  } catch (e) {
    console.log(`${id}: ERROR ${String(e).slice(0, 120)}`)
  }
}
for (const prefix of ['REGAL-JACKET', 'WATERPROOF-OVERJACKET', 'MISANO-JACKET']) {
  const parents = await prisma.product.findMany({
    where: { sku: { startsWith: prefix }, parentId: null, deletedAt: null },
    select: { id: true, sku: true, productType: true, _count: { select: { children: true } } },
    orderBy: { sku: 'asc' },
  })
  for (const p of parents) {
    const mems = await prisma.sharedListingMembership.count({ where: { parentSku: p.sku } })
    const cl = await prisma.channelListing.findFirst({
      where: { productId: p.id, channel: 'EBAY', marketplace: 'IT' },
      select: { externalListingId: true, platformAttributes: true },
    })
    const pa = (cl?.platformAttributes ?? {}) as Record<string, unknown>
    console.log(`DB ${p.sku}: type=${p.productType} children=${p._count.children} memberships=${mems} cl.itemId=${cl?.externalListingId ?? '(none)'} shared_flag=${pa.shared_sku_listing ?? ''} offerIds=${pa.__offerIds ? 'YES-INVENTORY-LANE' : 'no'}`)
  }
  if (!parents.length) console.log(`DB ${prefix}*: no parentless products`)
}
await prisma.$disconnect()
