/** READ-ONLY: structural probe for REGAL / WATERPROOF / MISANO cited listings + DB pools. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
for (const id of ['256566112769']) {
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
await prisma.$disconnect()
