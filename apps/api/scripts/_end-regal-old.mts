/** Option-A endings (owner-approved): end REGAL old listings; prints eBay's real error on failure. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { endFixedPriceItem, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
for (const itemId of ['256550346578', '256568112735']) {
  try {
    await endFixedPriceItem({ itemId }, { oauthToken: token, siteId: siteIdForMarket('IT') })
    console.log(`${itemId}: ENDED`)
  } catch (e) {
    console.log(`${itemId}: FAILED → ${String(e instanceof Error ? e.message : e).slice(0, 400)}`)
  }
}
await prisma.$disconnect()
