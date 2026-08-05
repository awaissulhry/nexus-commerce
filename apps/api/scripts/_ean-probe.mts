process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket, escapeXml } = await import('../src/services/ebay-trading-api.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const res = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>256566101420</ItemID></GetItemRequest>`, { oauthToken: token, siteId: siteIdForMarket('IT') })
const m = res.raw.match(/<VariationProductListingDetails>[\s\S]*?<\/VariationProductListingDetails>/)
console.log('sample VariationProductListingDetails:', m ? m[0].slice(0, 200) : 'NONE FOUND')
await prisma.$disconnect(); process.exit(0)
