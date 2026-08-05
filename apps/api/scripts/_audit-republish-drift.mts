/** READ-ONLY: would re-publishing AIRMESH / GALE change anything beyond the axis
 * NAMES? Compares LIVE eBay (GetItem) against what our local family data holds.
 * No writes, no publish. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')

const TARGETS = [
  { sku: 'AIRMESH-JACKET', itemId: '257611257473' },
  { sku: 'GALE-JACKET', itemId: '257584954808' },
]
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)

for (const t of TARGETS) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${t.itemId}</ItemID>
  <OutputSelector>Item.Title</OutputSelector>
  <OutputSelector>Item.SellingStatus.ListingStatus</OutputSelector>
  <OutputSelector>Item.PictureDetails.PictureURL</OutputSelector>
  <OutputSelector>Item.Variations.Variation.SKU</OutputSelector>
  <OutputSelector>Item.Variations.Variation.StartPrice</OutputSelector>
  <OutputSelector>Item.Variations.Variation.Quantity</OutputSelector>
  <OutputSelector>Item.Variations.VariationSpecificsSet</OutputSelector>
</GetItemRequest>`
  const raw = (await callTradingApi('GetItem', xml, { oauthToken: token, siteId: siteIdForMarket('IT') })).raw
  const title = /<Title>([^<]*)<\/Title>/.exec(raw)?.[1] ?? ''
  const status = /<ListingStatus>([^<]*)<\/ListingStatus>/.exec(raw)?.[1] ?? ''
  const pics = (raw.match(/<PictureURL>/g) || []).length
  const liveVars = [...raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map((m) => ({
    sku: /<SKU>([^<]*)<\/SKU>/.exec(m[1])?.[1] ?? '',
    price: /<StartPrice[^>]*>([^<]*)<\/StartPrice>/.exec(m[1])?.[1] ?? '',
    qty: /<Quantity>([^<]*)<\/Quantity>/.exec(m[1])?.[1] ?? '',
  }))
  const axes = [...(/<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/.exec(raw)?.[1] ?? '')
    .matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1])

  // LOCAL: the pool family + its memberships for this listing
  const parent = await prisma.product.findFirst({ where: { sku: t.sku, deletedAt: null }, select: { id: true, name: true } })
  const memb = await prisma.sharedListingMembership.findMany({
    where: { itemId: t.itemId, status: 'ACTIVE' },
    select: { sku: true, price: true },
  })
  const children = parent ? await prisma.product.count({ where: { parentId: parent.id, deletedAt: null } }) : 0

  console.log(`\n=== ${t.sku} (${t.itemId}) [${status}] ===`)
  console.log(`  live title      : ${title.slice(0, 70)}`)
  console.log(`  live axes       : ${JSON.stringify(axes)}`)
  console.log(`  live variations : ${liveVars.length}   live gallery pics: ${pics}`)
  console.log(`  local children  : ${children}   memberships for this itemId: ${memb.length}`)
  const liveSkus = new Set(liveVars.map((v) => v.sku))
  const membSkus = new Set(memb.map((m) => m.sku))
  const onlyLive = [...liveSkus].filter((s) => s && !membSkus.has(s))
  const onlyLocal = [...membSkus].filter((s) => !liveSkus.has(s))
  console.log(`  SKUs only LIVE  : ${onlyLive.length ? JSON.stringify(onlyLive.slice(0, 6)) : 'none'}`)
  console.log(`  SKUs only LOCAL : ${onlyLocal.length ? JSON.stringify(onlyLocal.slice(0, 6)) : 'none'}`)
  const priceMismatch = memb.filter((m) => {
    const lv = liveVars.find((v) => v.sku === m.sku)
    return lv && m.price != null && Number(m.price) !== Number(lv.price)
  })
  console.log(`  price mismatches: ${priceMismatch.length}${priceMismatch.length ? ' → ' + JSON.stringify(priceMismatch.slice(0, 4).map((m) => `${m.sku}: local ${m.price} vs live ${liveVars.find((v) => v.sku === m.sku)?.price}`)) : ''}`)
  const zeroQty = liveVars.filter((v) => Number(v.qty) === 0).length
  console.log(`  live variations at qty 0: ${zeroQty}/${liveVars.length}`)
}
await prisma.$disconnect()
