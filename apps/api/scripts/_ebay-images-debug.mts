/** DEBUG: what does GetItem actually return for pictures? Try the Item.-prefixed
 * OutputSelectors and dump the picture-related XML so we fix the parser to reality. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')

const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const itemId = '257629891728' // VENTRA primary (has per-colour images)

const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.PictureDetails.PictureURL</OutputSelector>
  <OutputSelector>Item.Variations.Pictures</OutputSelector>
</GetItemRequest>`
const res = await callTradingApi('GetItem', xml, { oauthToken: token, siteId: siteIdForMarket('IT') })
const raw: string = res.raw
console.log('raw length:', raw.length)
console.log('has <PictureDetails>:', /<PictureDetails>/.test(raw))
console.log('<PictureURL> count:', (raw.match(/<PictureURL>/g) || []).length)
console.log('has <Pictures>:', /<Pictures>/.test(raw))
console.log('has <VariationSpecificPictureSet>:', /<VariationSpecificPictureSet>/.test(raw))
console.log('has <VariationSpecificName>:', /<VariationSpecificName>/.test(raw))
const pd = raw.match(/<PictureDetails>[\s\S]*?<\/PictureDetails>/)
console.log('\n--- PictureDetails block (first 700) ---\n', pd ? pd[0].slice(0, 700) : 'NONE')
const pics = raw.match(/<Pictures>[\s\S]*?<\/Pictures>/)
console.log('\n--- Pictures block (first 900) ---\n', pics ? pics[0].slice(0, 900) : 'NONE')
console.log('\n--- raw head (400) ---\n', raw.slice(0, 400))
await prisma.$disconnect()
