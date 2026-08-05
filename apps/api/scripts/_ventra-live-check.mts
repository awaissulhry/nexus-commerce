process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
for (const id of ['256552369326', '256568118281', '256568120099']) {
  try {
    const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${id}</ItemID></GetItemRequest>`, { oauthToken: token, siteId: siteIdForMarket('IT') })
    const status = /<ListingStatus>([^<]+)<\/ListingStatus>/.exec(got.raw)?.[1] ?? '?'
    const title = /<Title>([^<]{0,50})/.exec(got.raw)?.[1] ?? ''
    const varCount = [...got.raw.matchAll(/<Variation>/g)].length
    const axes = [...(/<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/.exec(got.raw)?.[1] ?? '').matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1])
    console.log(`${id}: status=${status} variations=${varCount} axes=${JSON.stringify(axes)} title="${title}"`)
  } catch (e) {
    console.log(`${id}: ERROR ${String(e).slice(0, 90)}`)
  }
}
await prisma.$disconnect()
