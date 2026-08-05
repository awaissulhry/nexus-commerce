/** READ-ONLY Phase 1: label coverage audit — every live eBay listing we know. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')

// 1) Saponette focus
const sap = await prisma.channelListing.findFirst({
  where: { channel: 'EBAY', externalListingId: '256566112769' },
  select: { id: true, marketplace: true, region: true, externalListingId: true, platformAttributes: true,
    product: { select: { id: true, sku: true, parentId: true, productType: true, _count: { select: { children: true } },
      parent: { select: { sku: true } } } } },
})
if (sap) {
  const pa = (sap.platformAttributes ?? {}) as Record<string, unknown>
  console.log('SAPONETTE CL:', JSON.stringify({
    productSku: sap.product?.sku, parentOfProduct: sap.product?.parent?.sku ?? null,
    children: sap.product?._count.children, type: sap.product?.productType,
    marketplace: sap.marketplace, region: sap.region,
    lane: pa.__offerIds ? 'INVENTORY' : 'TRADING/legacy', shared_flag: pa.shared_sku_listing ?? false,
  }))
  const mems = await prisma.sharedListingMembership.count({ where: { itemId: '256566112769' } })
  console.log('SAPONETTE memberships:', mems)
} else console.log('SAPONETTE: no CL with that itemId')

// 2) Universe of live itemIds we track
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', externalListingId: { not: null }, product: { deletedAt: null } },
  select: { externalListingId: true, marketplace: true, region: true, platformAttributes: true,
    product: { select: { sku: true, parentId: true, parent: { select: { sku: true } }, _count: { select: { children: true } } } } },
})
const memGroups = await prisma.sharedListingMembership.groupBy({ by: ['marketplace', 'itemId', 'parentSku'] })
const memByItem = new Map(memGroups.map((g) => [g.itemId, g.parentSku ?? '']))
const seen = new Map<string, { expected: string; source: string; mkt: string }>()
for (const g of memGroups) {
  if (g.parentSku && !/^\d+$/.test(g.parentSku)) seen.set(g.itemId, { expected: g.parentSku, source: 'membership', mkt: g.marketplace })
}
for (const cl of cls) {
  const iid = String(cl.externalListingId)
  if (seen.has(iid)) continue
  const p = cl.product!
  const expected = p._count.children > 0 ? p.sku : (p.parent?.sku ?? p.sku)
  seen.set(iid, { expected, source: 'CL-laneA', mkt: (cl.marketplace ?? cl.region ?? 'IT') as string })
}
console.log(`\nUNIVERSE: ${seen.size} distinct live itemIds (${memGroups.length ? [...new Set(memGroups.map((g) => g.itemId))].length : 0} membership-backed)`)

// 3) GetItem each → label state (throttled sequential; OutputSelector keeps it cheap)
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const rows: string[] = []
let missing = 0, mismatched = 0, ok = 0, dead = 0, errors = 0
for (const [iid, info] of seen) {
  try {
    const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${iid}</ItemID><OutputSelector>Item.SKU</OutputSelector><OutputSelector>Item.ListingDetails.EndTime</OutputSelector><OutputSelector>Item.SellingStatus.ListingStatus</OutputSelector></GetItemRequest>`,
      { oauthToken: token, siteId: siteIdForMarket(info.mkt) })
    const status = /<ListingStatus>([^<]+)<\/ListingStatus>/.exec(got.raw)?.[1] ?? '?'
    if (status !== 'Active') { dead++; continue }
    const liveSku = /<SKU>([^<]*)<\/SKU>/.exec(got.raw)?.[1] ?? ''
    if (!liveSku) { missing++; rows.push(`MISSING ${iid} (${info.source}) expected="${info.expected}"`) }
    else if (liveSku !== info.expected) { mismatched++; rows.push(`MISMATCH ${iid} (${info.source}) live="${liveSku}" expected="${info.expected}"`) }
    else ok++
  } catch (e) {
    errors++; rows.push(`ERROR ${iid}: ${String(e).slice(0, 80)}`)
  }
}
console.log(`\nLABEL AUDIT (Active listings): ok=${ok} missing=${missing} mismatched=${mismatched} endedOrDead=${dead} errors=${errors}`)
for (const r of rows) console.log('  ' + r)
await prisma.$disconnect()
