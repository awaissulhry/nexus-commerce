/** READ-ONLY: what pictures do the ADOPTED Trading listings carry for Nero?
 * If they match the 3 Amazon URLs the inventory_item reverts to, eBay's own
 * Trading→Inventory sync is the reverter. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const REVERT_SET = ['719YfFDNBOL', '91H1cawzU6L', '91IAKoHCQtL'] // what inventory_item keeps reverting to (Nero)

const memb = await prisma.sharedListingMembership.findMany({
  where: { parentSku: { contains: 'GALE' }, status: 'ACTIVE' }, select: { itemId: true, parentSku: true }, distinct: ['itemId'],
})
console.log('GALE-family listings:', JSON.stringify(memb.map((m) => `${m.parentSku}:${m.itemId}`)))
for (const m of memb) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${m.itemId}</ItemID>
  <OutputSelector>Item.Variations.Pictures</OutputSelector></GetItemRequest>`
  try {
    const raw = (await callTradingApi('GetItem', xml, { oauthToken: token, siteId: siteIdForMarket('IT') })).raw
    const pics = /<Pictures>([\s\S]*?)<\/Pictures>/.exec(raw)?.[1] ?? ''
    const sets = [...pics.matchAll(/<VariationSpecificPictureSet>([\s\S]*?)<\/VariationSpecificPictureSet>/g)]
    let neroInfo = 'no picture sets'
    for (const s of sets) {
      const val = /<VariationSpecificValue>([^<]*)<\/VariationSpecificValue>/.exec(s[1])?.[1] ?? ''
      if (!/nero/i.test(val)) continue
      const urls = [...s[1].matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)].map((x) => x[1])
      const amazonIds = urls.filter((u) => u.includes('media-amazon')).map((u) => (u.match(/I\/([A-Za-z0-9+]+)\./)?.[1] ?? ''))
      const revertHits = REVERT_SET.filter((id) => amazonIds.some((a) => a.includes(id))).length
      neroInfo = `Nero: ${urls.length} pics (${urls.filter((u) => u.includes('media-amazon')).length} amazon, ${urls.filter((u) => u.includes('cloudinary')).length} cloudinary) — contains ${revertHits}/3 of the REVERT set`
    }
    console.log(`  ${m.parentSku} ${m.itemId}: ${neroInfo}`)
  } catch (e) { console.log(`  ${m.parentSku} ${m.itemId}: ERR ${(e as Error).message.slice(0, 80)}`) }
}
await prisma.$disconnect()
