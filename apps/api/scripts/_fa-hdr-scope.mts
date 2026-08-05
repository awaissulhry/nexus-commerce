/** READ-ONLY: does the family-scoped header rollup differ from the family's own? */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveIntendedQuantity, resolveMembershipIntended } = await import('../src/services/sync-control-core.js')
const { resolveCanonicalMap, canonicalStem, summarizeProductSync, summarizeFamilies, familyKeyOf } = await import('../src/services/sync-control-product-view.js')

const policies = await prisma.syncChannelPolicy.findMany()
const policyFor = (ch: string, mk: string) =>
  policies.find((p) => p.channel === ch && p.marketplace === mk) ??
  policies.find((p) => p.channel === ch && p.marketplace === '*') ?? null

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: {
    productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
    followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true },
})
const pids = [...new Set([...listings.map((l) => l.productId), ...memberships.map((m) => m.productId).filter(Boolean) as string[]])]
const levels = await prisma.stockLevel.findMany({ where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } } })
const ledgers = new Map<string, any[]>()
for (const l of levels) {
  const a = ledgers.get(l.productId) ?? []; a.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] }); ledgers.set(l.productId, a)
}
const modeOf = (r: any, shared: boolean) => r.kind === 'FBA_EXCLUDED' ? 'FBA' : r.kind === 'PAUSED' ? (r.via === 'POLICY' ? 'PAUSED_POLICY' : shared ? 'EXCLUDED' : 'PAUSED') : r.kind
const rows: any[] = []
for (const cl of listings) {
  const isFba = cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') || cl.product?.fulfillmentMethod === 'FBA'
  const r = resolveIntendedQuantity({ channel: cl.channel, marketplace: cl.marketplace, isFba, followMasterQuantity: cl.followMasterQuantity, syncPaused: cl.syncPaused, pinnedQuantity: cl.quantity, stockBuffer: cl.stockBuffer ?? 0, sourceLocationCodes: cl.sourceLocationCodes ?? [], channelPolicy: policyFor(cl.channel, cl.marketplace) as any, ledger: ledgers.get(cl.productId) ?? [] })
  rows.push({ lane: 'LISTING', sku: cl.product?.sku ?? '?', productId: cl.productId, channel: cl.channel, marketplace: cl.marketplace, mode: modeOf(r, false), intendedQty: r.kind === 'FOLLOW' || r.kind === 'PINNED' ? (r as any).quantity : null, liveQty: cl.quantity, buffer: cl.stockBuffer ?? 0, routedLocations: r.kind === 'FOLLOW' ? (r as any).routedLocations : [] })
}
for (const m of memberships) {
  const r = resolveMembershipIntended({ marketplace: m.marketplace, followPool: m.followPool ?? true, stockBuffer: m.stockBuffer ?? 0, channelPolicy: policyFor('EBAY', m.marketplace) as any, ledger: m.productId ? (ledgers.get(m.productId) ?? []) : [] })
  rows.push({ lane: 'SHARED', sku: m.sku, productId: m.productId, channel: 'EBAY', marketplace: m.marketplace, mode: modeOf(r, true), intendedQty: r.kind === 'FOLLOW' ? (r as any).quantity : null, liveQty: m.lastQtyPushed, buffer: m.stockBuffer ?? 0, routedLocations: r.kind === 'FOLLOW' ? (r as any).routedLocations : [], itemId: m.itemId })
}
const rowPids = [...new Set(rows.map((r) => r.productId).filter(Boolean))]
const rp = await prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } })
const masterOf = new Map(rp.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]
const withChildren = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const masterSkus = await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })
const mwc = new Set(withChildren.map((p) => p.parentId!).filter(Boolean))
const childless = masterIds.filter((id) => !mwc.has(id))
const stemOfMaster = new Map<string, string>(); const canonicalByStem = new Map<string, string>()
const ordered = [...masterSkus].sort((a, b) => {
  const sa = canonicalStem(a.sku), sb = canonicalStem(b.sku)
  const ea = a.sku.toUpperCase() === sa ? 0 : 1, eb = b.sku.toUpperCase() === sb ? 0 : 1
  return ea - eb || a.sku.localeCompare(b.sku)
})
for (const m of ordered) { const s = canonicalStem(m.sku); stemOfMaster.set(m.id, s); if (mwc.has(m.id) && !canonicalByStem.has(s)) canonicalByStem.set(s, m.id) }
const itemIdsByMaster = new Map<string, string[]>(); const canonByItem = new Map<string, string>()
if (childless.length) {
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
  const ids = new Set<string>()
  for (const c of cls) { const a = itemIdsByMaster.get(c.productId) ?? []; a.push(c.externalListingId!); itemIdsByMaster.set(c.productId, a); ids.add(c.externalListingId!) }
  if (ids.size) {
    const mems = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...ids] } }, select: { itemId: true, productId: true } })
    const mp = await prisma.product.findMany({ where: { id: { in: [...new Set(mems.map((m) => m.productId!).filter(Boolean))] } }, select: { id: true, parentId: true } })
    const mo = new Map(mp.map((p) => [p.id, p.parentId ?? p.id]))
    for (const m of mems) { if (!m.productId || canonByItem.has(m.itemId)) continue; const c = mo.get(m.productId); if (c && mwc.has(c)) canonByItem.set(m.itemId, c) }
  }
}
const canonicalOf = resolveCanonicalMap(masterIds, mwc, itemIdsByMaster, canonByItem, canonicalByStem, stemOfMaster)
const byGroup = new Map<string, any[]>()
for (const r of rows) { if (!r.productId) continue; const g = canonicalOf.get(masterOf.get(r.productId) ?? r.productId) ?? r.productId; const a = byGroup.get(g) ?? []; a.push(r); byGroup.set(g, a) }

const allItemIds = [...new Set(rows.map((r) => r.itemId).filter(Boolean))] as string[]
const ownerSkuByItemId = new Map<string, string>()
if (allItemIds.length) {
  const owners = await prisma.channelListing.findMany({ where: { externalListingId: { in: allItemIds } }, select: { externalListingId: true, product: { select: { sku: true, parent: { select: { sku: true } } } } } })
  for (const o of owners) { if (!o.externalListingId || ownerSkuByItemId.has(o.externalListingId)) continue; ownerSkuByItemId.set(o.externalListingId, o.product?.parent?.sku ?? o.product?.sku ?? '') }
}
const meta = await prisma.product.findMany({ where: { id: { in: [...byGroup.keys()] } }, select: { id: true, sku: true } })
const skuOf = new Map(meta.map((m) => [m.id, m.sku]))

console.log('=== multi-family groups: header (whole) vs family-scoped ===')
let mismatch = 0
for (const [g, rs] of byGroup) {
  const fams = summarizeFamilies(rs as any, ownerSkuByItemId)
  if (fams.length < 2) continue
  const whole = summarizeProductSync(rs)
  console.log(`\n${skuOf.get(g) ?? g}: whole listings=${whole.listings} drift=${whole.driftCount} channels=[${whole.channels.join(',')}] families=${fams.length}`)
  for (const f of fams) {
    const scoped = rs.filter((r) => familyKeyOf(r) === f.key)
    const s = summarizeProductSync(scoped)
    const differs = s.driftCount !== whole.driftCount || s.channels.join(',') !== whole.channels.join(',')
    if (differs) mismatch++
    console.log(`   ${differs ? 'DIFF' : 'same'} family ${f.key} owner=${f.ownerSku ?? '-'} listings=${s.listings} famDrift=${f.driftCount} scopedDrift=${s.driftCount} scopedChannels=[${s.channels.join(',')}]`)
  }
}
console.log('\nfamilies where header rollup would disagree with the scoped view:', mismatch)
await prisma.$disconnect()
