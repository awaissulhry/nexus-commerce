/** READ-ONLY: raw GetItem variation dump for the mismatch-pattern listings.
 *  (GetItem is a read; NEXUS_EBAY_REAL_API=true required for the live call.) */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { getItemQuantities, callTradingApi, buildGetItemQuantitiesXml } = await import('../src/services/ebay-trading-api.service.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')

const ITEMS = [
  { itemId: '257608449467', mp: 'EBAY_IT', label: 'WATERPROOF (8→16 pattern)' },
  { itemId: '257630525745', mp: 'EBAY_IT', label: 'knee-slider (43→86 pattern)' },
  { itemId: '257629891728', mp: 'EBAY_IT', label: 'VENTRA (0↔5 pattern)' },
]

const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
if (!conn) throw new Error('no connection')
const token = await ebayAuthService.getValidToken(conn.id)

for (const it of ITEMS) {
  console.log(`\n== ${it.label} item=${it.itemId} ==`)
  const memb = await prisma.sharedListingMembership.findMany({
    where: { itemId: it.itemId },
    select: { sku: true, lastQtyPushed: true, status: true, marketplace: true },
    orderBy: { sku: 'asc' },
  })
  console.log(`memberships: ${memb.length} (${memb[0]?.marketplace})`)
  try {
    const raw = await callTradingApi('GetItem', buildGetItemQuantitiesXml(it.itemId), {
      oauthToken: token,
      siteId: 101,
    })
    const rb = await getItemQuantities(it.itemId, { oauthToken: token, market: memb[0]?.marketplace ?? 'EBAY_IT' })
    console.log(`listingStatus=${rb.listingStatus} variations=${rb.variations.length} itemAvailable=${rb.itemAvailable}`)
    // duplicate-SKU check within the eBay listing itself
    const seen = new Map<string, number>()
    for (const v of rb.variations) seen.set(v.sku, (seen.get(v.sku) ?? 0) + 1)
    const dups = [...seen.entries()].filter(([, n]) => n > 1)
    console.log(`duplicate variation SKUs on eBay: ${dups.length ? dups.map(([s, n]) => `${s}×${n}`).join(', ') : 'none'}`)
    for (const m of memb.slice(0, 12)) {
      const obs = rb.variations.filter((v) => v.sku === m.sku).map((v) => v.available)
      console.log(`  ${m.sku.padEnd(38)} lastPushed=${String(m.lastQtyPushed).padEnd(4)} ebay=[${obs.join(',')}] ${m.status}`)
    }
    const itemQty = raw.raw.match(/<Quantity>(\d+)<\/Quantity>/)?.[1]
    const itemSold = raw.raw.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1]
    console.log(`raw item-level first Quantity tag=${itemQty} first QuantitySold=${itemSold} rawLen=${raw.raw.length}`)
  } catch (err) {
    console.log(`GetItem ERR: ${err instanceof Error ? err.message : String(err)}`)
  }
}
await prisma.$disconnect()
process.exit(0)
