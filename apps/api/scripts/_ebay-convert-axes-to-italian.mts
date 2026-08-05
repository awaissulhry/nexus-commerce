/** PHASE 6 batch: convert live eBay listings' variation AXIS NAMES to Italian
 * via the shared, TESTED ebay-axes-convert.service (Color→Colore, Size→Taglia;
 * matched by SKU + EAN). Trading listings only — Inventory-managed ones (GALE)
 * are reported as needing an Inventory re-publish.
 *
 * Usage:  tsx _ebay-convert-axes-to-italian.mts [itemId ...] [apply]
 *   no itemIds → the 3 drift-flagged listings; no "apply" → dry-run (read-only). */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { convertListingAxesToItalian, parseVariationsForRename, italianAxisName } = await import('../src/services/ebay-axes-convert.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')

const APPLY = process.argv.includes('apply')
const argIds = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
const ITEMS = argIds.length ? argIds : ['256550369887', '257611257473', '257584954808'] // slider, AIRMESH, GALE(Inventory)

const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)

console.log(`=== Convert axes → Italian (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${ITEMS.length} listing(s) ===`)
for (const itemId of ITEMS) {
  if (APPLY) {
    const r = await convertListingAxesToItalian(itemId, 'IT', { oauthToken: token })
    const tail = r.after ? ` → ${JSON.stringify(r.after)} (${r.variationsAfter} vars)` : r.message ? ` · ${r.message}` : ''
    console.log(`● ${itemId}: ${r.outcome} · renames ${JSON.stringify(r.renames)}${tail}`)
  } else {
    const getXml = `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${itemId}</ItemID><OutputSelector>Item.Variations.Variation.SKU</OutputSelector><OutputSelector>Item.Variations.VariationSpecificsSet</OutputSelector></GetItemRequest>`
    const { vars, axisSet } = parseVariationsForRename((await callTradingApi('GetItem', getXml, { oauthToken: token, siteId: siteIdForMarket('IT') })).raw)
    const renames = axisSet.map((a) => ({ from: a.name, to: italianAxisName(a.name) })).filter((r) => r.from !== r.to)
    console.log(`● ${itemId}: axes ${JSON.stringify(axisSet.map((a) => a.name))} · ${vars.length} vars · renames ${JSON.stringify(renames)} (dry-run — pass "apply")`)
  }
}
console.log('\n=== done ===')
await prisma.$disconnect()
