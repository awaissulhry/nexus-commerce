// READ-ONLY: GetItem picture state for a live listing (gallery + variation sets).
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket, escapeXml } = await import('../src/services/ebay-trading-api.service.js')

const itemId = process.argv[2] ?? '257628770752'
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const res = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID></GetItemRequest>`,
  { oauthToken: token, siteId: siteIdForMarket('IT') })

const pd = res.raw.match(/<PictureDetails>([\s\S]*?)<\/PictureDetails>/)?.[1] ?? ''
const galleryUrls = [...pd.matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)].map((m) => m[1])
console.log(`Item ${itemId} — gallery: ${galleryUrls.length} pictures`)
for (const u of galleryUrls.slice(0, 4)) console.log('  G:', u.slice(0, 110))

const pics = res.raw.match(/<Pictures>([\s\S]*?)<\/Pictures>/)?.[1] ?? ''
const axisName = pics.match(/<VariationSpecificName>([^<]+)<\/VariationSpecificName>/)?.[1] ?? '(none)'
console.log(`Variation picture axis: ${axisName}`)
for (const set of pics.matchAll(/<VariationSpecificPictureSet>([\s\S]*?)<\/VariationSpecificPictureSet>/g)) {
  const val = set[1].match(/<VariationSpecificValue>([^<]+)<\/VariationSpecificValue>/)?.[1]
  const urls = [...set[1].matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)]
  console.log(`  ${val}: ${urls.length} pictures — first: ${urls[0]?.[1]?.slice(0, 90) ?? '-'}`)
}
await prisma.$disconnect()
process.exit(0)
