/** READ-ONLY probe 3 — prove the `not: 'FBA'` no-op on a real row; folded masters. */
const { default: prisma } = await import('../src/db.js')
const { resolveCanonicalMap, canonicalStem } = await import('../src/services/sync-control-product-view.js')

// 1. exact where-clause the import apply uses, on a real NULL-fm listing
const target = await prisma.product.findFirst({ where: { sku: 'AIREON-JACKET-CREMA-E-VINO-MEN-XS' }, select: { id: true, sku: true, fulfillmentMethod: true } })
if (target) {
  const all = await prisma.channelListing.count({ where: { productId: target.id, channel: 'AMAZON', marketplace: 'IT' } })
  const notFba = await prisma.channelListing.count({ where: { productId: target.id, channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: { not: 'FBA' } } })
  console.log('IMPORT-APPLY where-clause match on', target.sku, { rowsThatExist: all, rowsTheUpdateManyWouldTouch: notFba, productFm: target.fulfillmentMethod })
}

// 2. how many controllable published rows would the PAUSE/PIN updateMany miss?
const missed = await prisma.$queryRawUnsafe<any[]>(
  `SELECT count(*)::int AS n FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
      AND cl."fulfillmentMethod" IS NULL AND coalesce(p."fulfillmentMethod"::text,'')<>'FBA'`,
)
console.log('controllable (non-FBA) published listings the updateMany can never touch:', missed)

// 3. FBA-by-stock but not flagged: computeRows shows them editable, setFollowMasterQuantity skips them
const fbaStock = await prisma.$queryRawUnsafe<any[]>(
  `SELECT count(DISTINCT cl.id)::int AS n FROM "ChannelListing" cl
     JOIN "Product" p ON p.id=cl."productId"
     JOIN "StockLevel" sl ON sl."productId"=p.id
     JOIN "StockLocation" loc ON loc.id=sl."locationId" AND loc.type='AMAZON_FBA'
    WHERE cl.channel='AMAZON' AND cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
      AND sl.quantity > 0
      AND coalesce(cl."fulfillmentMethod"::text,'') <> 'FBA' AND coalesce(p."fulfillmentMethod"::text,'') <> 'FBA'`,
)
console.log('AMAZON listings with FBA stock but NOT flagged FBA (export not locked, writes silently skipped):', fbaStock)

// 4. folded masters (SCD.1) — a per-product page opened on a folded id exports EMPTY
const masters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true } })
const ids = masters.map((m) => m.id)
const withChildren = await prisma.product.findMany({ where: { parentId: { in: ids } }, select: { parentId: true }, distinct: ['parentId'] })
const mastersWithChildren = new Set(withChildren.map((p) => p.parentId!).filter(Boolean))
const childless = ids.filter((id) => !mastersWithChildren.has(id))
const stemOfMaster = new Map<string, string>(); const canonicalByStem = new Map<string, string>()
const ordered = [...masters].sort((a, b) => {
  const [sa, sb] = [canonicalStem(a.sku), canonicalStem(b.sku)]
  const [ea, eb] = [a.sku.toUpperCase() === sa ? 0 : 1, b.sku.toUpperCase() === sb ? 0 : 1]
  return ea - eb || a.sku.localeCompare(b.sku)
})
for (const m of ordered) {
  const stem = canonicalStem(m.sku); stemOfMaster.set(m.id, stem)
  if (mastersWithChildren.has(m.id) && !canonicalByStem.has(stem)) canonicalByStem.set(stem, m.id)
}
const itemIdsByMaster = new Map<string, string[]>(); const canonicalMasterByItemId = new Map<string, string>()
const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const allItemIds = new Set<string>()
for (const c of cls) { const a = itemIdsByMaster.get(c.productId) ?? []; a.push(c.externalListingId!); itemIdsByMaster.set(c.productId, a); allItemIds.add(c.externalListingId!) }
const mems = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: [...allItemIds] } }, select: { itemId: true, productId: true } })
const memProducts = await prisma.product.findMany({ where: { id: { in: [...new Set(mems.map((m) => m.productId!).filter(Boolean))] } }, select: { id: true, parentId: true } })
const masterOfProduct = new Map(memProducts.map((p) => [p.id, p.parentId ?? p.id]))
for (const m of mems) { if (!m.productId || canonicalMasterByItemId.has(m.itemId)) continue; const c = masterOfProduct.get(m.productId); if (c && mastersWithChildren.has(c)) canonicalMasterByItemId.set(m.itemId, c) }
const canon = resolveCanonicalMap(ids, mastersWithChildren, itemIdsByMaster, canonicalMasterByItemId, canonicalByStem, stemOfMaster)
const skuById = new Map(masters.map((m) => [m.id, m.sku]))
const folded = [...canon.entries()].filter(([mid, cid]) => mid !== cid)
console.log(`folded masters: ${folded.length} / ${ids.length}`)
console.table(folded.slice(0, 12).map(([mid, cid]) => ({ foldedSku: skuById.get(mid), foldedId: mid, canonicalSku: skuById.get(cid) })))

await prisma.$disconnect()
