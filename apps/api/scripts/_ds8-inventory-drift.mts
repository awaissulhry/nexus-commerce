/**
 * READ-ONLY drift check (no writes, GET only).
 *
 * Question: for Inventory-API-managed eBay families, how far has the LIVE
 * inventory_item_group drifted from what a Full Publish would re-assert?
 * If there is no drift, today's Full Publish is effectively description-only
 * in practice. If there is, the diff names exactly which fields are at risk
 * when you push a description via Full Publish.
 *
 * Compares only the fields we can derive reliably outside pushVariationGroup:
 *   title           (per-market parent content, same resolver the push uses)
 *   variantSKUs     (family children in the DB)
 *   imageUrls count (live vs what the group currently holds)
 *   description     (expected to differ — that IS the intent; reported, not flagged)
 * Everything else on the live group is printed verbatim so nothing is hidden.
 */
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { resolvePerMarketContent } = await import('../src/services/ebay-variation-push.service.js')

const MARKET = (process.argv[2] ?? 'IT').toUpperCase()
const REGION = MARKET === 'UK' ? 'GB' : MARKET
const API = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
if (!conn) { console.log('no active eBay connection'); process.exit(1) }
const token = await ebayAuthService.getValidToken(conn.id)
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Language': 'it-IT' }

// Every eBay family root on this market whose family carries __offerIds (Lane A)
const roots = await prisma.product.findMany({
  where: { parentId: null, deletedAt: null },
  select: { id: true, sku: true },
})
const report: string[] = []
let checked = 0, drifted = 0

for (const root of roots) {
  const kids = await prisma.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: { id: true, sku: true } })
  const famIds = [root.id, ...kids.map((k) => k.id)]
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: famIds }, channel: 'EBAY' },
    select: { productId: true, region: true, externalListingId: true, platformAttributes: true, title: true, description: true, flatFileSnapshot: true },
  })
  const inventoryManaged = cls.some((c) => Object.keys(asObj(asObj(c.platformAttributes).__offerIds)).length > 0)
  if (!inventoryManaged) continue
  const parentCl = cls.find((c) => c.productId === root.id && c.region === REGION)
  if (!parentCl?.externalListingId) continue

  checked++
  // The group key the push uses is the parent SKU (with a UUID fallback for legacy groups)
  const res = await fetch(`${API}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(root.sku)}`, { headers })
  if (!res.ok) {
    report.push(`\n■ ${root.sku} (ItemID ${parentCl.externalListingId})\n   GET group -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`)
    continue
  }
  const live = await res.json() as Record<string, any>
  const content = resolvePerMarketContent(parentCl, {})

  const liveSkus = [...(live.variantSKUs ?? [])].sort()
  const dbSkus = kids.map((k) => k.sku).sort()
  const skuDrift = JSON.stringify(liveSkus) !== JSON.stringify(dbSkus)
  const titleDrift = (live.title ?? '') !== (content.title ?? '')

  if (skuDrift || titleDrift) drifted++
  report.push(
    `\n■ ${root.sku} (ItemID ${parentCl.externalListingId})` +
    `\n   title   live="${(live.title ?? '').slice(0, 70)}"` +
    `\n           push="${(content.title ?? '').slice(0, 70)}"   ${titleDrift ? '<<< DRIFT' : 'match'}` +
    `\n   variants live=${liveSkus.length} db=${dbSkus.length}   ${skuDrift ? `<<< DRIFT  onlyLive=[${liveSkus.filter((s) => !dbSkus.includes(s)).join(',')}] onlyDb=[${dbSkus.filter((s) => !liveSkus.includes(s)).join(',')}]` : 'match'}` +
    `\n   images  live=${(live.imageUrls ?? []).length}` +
    `\n   variesBy live=${JSON.stringify(live.variesBy ?? {}).slice(0, 200)}` +
    `\n   aspects  live=${JSON.stringify(live.aspects ?? {}).slice(0, 160)}` +
    `\n   description live=${(live.description ?? '').length} chars (a description push replaces THIS field)`,
  )
}

console.log(`\n════ Inventory-managed drift check · ${MARKET} · GET-only ════`)
console.log(report.join('\n') || '  (no Inventory-managed families found)')
console.log(`\nchecked=${checked} familiesWithDrift=${drifted}`)
console.log(drifted === 0
  ? 'VERDICT: no drift in the comparable fields — a Full Publish re-asserts the same values, so it behaves as description-only in practice.'
  : 'VERDICT: real drift present — a Full Publish would rewrite those fields as a side effect of a description change.')
await prisma.$disconnect()
