/** PHASE 0 — READ-ONLY live truth table. Calls eBay GetItem (read-only) for VENTRA's
 * listings + a sample across families, and prints: LIVE axes (VariationSpecificsSet) vs
 * DECLARED theme vs STORED variationSpecifics. No writes of any kind. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')
const { parseLiveVariations } = await import('../src/services/ebay-membership-reconcile.service.js')

const MKT = 'IT'
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)

// --- pick itemIds: all VENTRA-JACKET listings + VENTRA ended + 1 per sample family ---
const active = await prisma.sharedListingMembership.findMany({
  where: { marketplace: MKT }, select: { itemId: true, parentSku: true, status: true, variationSpecifics: true },
})
const famItems = new Map<string, Set<string>>()
const storedByItem = new Map<string, Set<string>>()
for (const m of active) {
  if (!famItems.has(m.parentSku)) famItems.set(m.parentSku, new Set())
  famItems.get(m.parentSku)!.add(m.itemId)
  if (!storedByItem.has(m.itemId)) storedByItem.set(m.itemId, new Set())
  const vs = m.variationSpecifics
  if (vs && typeof vs === 'object' && !Array.isArray(vs)) for (const k of Object.keys(vs)) storedByItem.get(m.itemId)!.add(k)
}
const SAMPLE_FAMS = ['AIREON', 'GALE-JACKET', 'IT-GALE-JACKET', 'AIRMESH-JACKET', 'IT-MOSS-JACKET', 'xavia-knee-slider']
const probeIds = new Set<string>()
for (const it of famItems.get('VENTRA-JACKET') ?? []) probeIds.add(it)
probeIds.add('256552369326') // VENTRA's ENDED corpse
for (const fam of SAMPLE_FAMS) { const it = [...(famItems.get(fam) ?? [])][0]; if (it) probeIds.add(it) }

// --- declared themes for VENTRA parents (context) ---
const parents = await prisma.product.findMany({ where: { sku: { in: ['VENTRA-JACKET', 'VENTRA-JACKET-ALT1', 'VENTRA-JACKET-ALT2', 'AIREON', 'GALE-JACKET', 'IT-GALE-JACKET', 'AIRMESH-JACKET', 'IT-MOSS-JACKET'] }, deletedAt: null }, select: { sku: true, variationTheme: true } })
const themeBySku = new Map(parents.map((p) => [p.sku, p.variationTheme]))

function parseSpecificsSet(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const block = /<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/.exec(raw)?.[1] ?? ''
  for (const nv of block.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)) {
    const name = /<Name>([^<]*)<\/Name>/.exec(nv[1])?.[1] ?? ''
    const vals = [...nv[1].matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => m[1])
    if (name) out[name] = vals
  }
  return out
}
function parseItemSpecificsKeys(raw: string): string[] {
  const block = /<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/.exec(raw)?.[1] ?? ''
  return [...block.matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1])
}

console.log('=== PHASE 0: LIVE eBay TRUTH (read-only GetItem) ===')
console.log('probing', probeIds.size, 'listings\n')
for (const itemId of probeIds) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.SKU</OutputSelector>
  <OutputSelector>Item.SellingStatus.ListingStatus</OutputSelector>
  <OutputSelector>Item.Variations.VariationSpecificsSet</OutputSelector>
  <OutputSelector>Item.Variations.Variation.SKU</OutputSelector>
  <OutputSelector>Item.Variations.Variation.VariationSpecifics</OutputSelector>
  <OutputSelector>Item.ItemSpecifics</OutputSelector>
</GetItemRequest>`
  try {
    const res = await callTradingApi('GetItem', xml, { oauthToken: token, siteId: siteIdForMarket(MKT) })
    const raw: string = res.raw
    const status = /<ListingStatus>([^<]*)<\/ListingStatus>/.exec(raw)?.[1] ?? '?'
    const label = /<SKU>([^<]*)<\/SKU>/.exec(raw)?.[1] ?? '(none)'
    const set = parseSpecificsSet(raw)
    const liveAxes = Object.entries(set).map(([n, v]) => `${n}(${v.length})`)
    const live = parseLiveVariations(raw)
    const perVarKeys = new Set<string>()
    for (const v of live) for (const k of Object.keys(v.specifics)) perVarKeys.add(k)
    const itemSpecKeys = parseItemSpecificsKeys(raw)
    console.log(`● itemId ${itemId}  [${status}]  label=${label}`)
    console.log(`   LIVE VariationSpecificsSet (the real axes): ${JSON.stringify(liveAxes)}`)
    for (const [n, v] of Object.entries(set)) if (/colo|gener|sesso|taglia|size/i.test(n)) console.log(`      ${n}: ${JSON.stringify(v)}`)
    console.log(`   live #variations=${live.length}, per-variation specifics keys=${JSON.stringify([...perVarKeys])}`)
    console.log(`   listing-level ItemSpecifics keys=${JSON.stringify(itemSpecKeys)}`)
    console.log(`   OUR stored variationSpecifics keys=${JSON.stringify([...(storedByItem.get(itemId) ?? [])])}`)
  } catch (e) {
    console.log(`● itemId ${itemId}  ERROR: ${(e as Error).message}`)
  }
  console.log('')
}
console.log('VENTRA declared themes:', JSON.stringify([...themeBySku].filter(([k]) => k.startsWith('VENTRA'))))
console.log('\n=== END (no writes) ===')
await prisma.$disconnect()
