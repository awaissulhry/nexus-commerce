/** MX.1 phase 0 — READ-ONLY readings on ONE named database (every statement a SELECT). */
const url = process.argv[2]
if (!url) { console.error('usage: tsx phase0.mts <DATABASE_URL>'); process.exit(2) }
console.log('DB host:', url.split('@')[1]?.split('/')[0], '| db:', url.split('/').pop()?.split('?')[0])
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const q = <T = Record<string, unknown>>(s: string, ...a: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...a)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))
console.log('current_database:', j(await q(`SELECT current_database(), current_user`)))
console.log('DISCRIMINATOR GALE:', j(await q(`SELECT id, sku, version, "fulfillmentMethod", "fulfillmentChannel", "isParent" FROM "Product" WHERE sku='GALE-JACKET'`)))
console.log('POSITIVE CONTROL Product rows:', j(await q(`SELECT count(*)::int n FROM "Product"`)))
const GALE = 'cmokmy3a40078pm0p1fvnu523'
console.log('\n=== (a) GALE per Amazon market: stored fulfillment vs guard inputs')
const rows = await q<any>(`
  SELECT c.sku, cl.marketplace, cl."fulfillmentMethod" AS cl_fm, c."fulfillmentMethod" AS p_fm, c."fulfillmentChannel" AS p_fc,
         cl."platformAttributes"->'fulfillment_availability'->0->>'fulfillment_channel_code' AS nested_code,
         cl."platformAttributes"->>'fulfillmentChannel' AS flat_code,
         cl."followMasterQuantity" fmq, cl.quantity, cl."quantityOverride" qo, cl."syncPaused" sp, cl."offerClosedAt" oc, cl."listingStatus" ls, cl."isPublished" pub,
         cl."stockBuffer" buf, cl.version, cl.price, cl."priceOverride" po, cl."followMasterPrice" fmp, cl."salePrice" sale, cl."aliasKey" ak, cl."channelConnectionId" conn,
         (SELECT coalesce(sum(sl.quantity),0)::int FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId" WHERE sl."productId"=c.id AND loc.code='AMAZON-EU-FBA') fba_qty,
         EXISTS(SELECT 1 FROM "Offer" o WHERE o."channelListingId"=cl.id AND o."fulfillmentMethod"='FBA' AND o."isActive") fba_offer
  FROM "ChannelListing" cl JOIN "Product" c ON c.id=cl."productId"
  WHERE (c.id=$1 OR c."parentId"=$1) AND cl.channel='AMAZON' ORDER BY c.sku, cl.marketplace`, GALE)
const isFba = (r: any) => r.cl_fm === 'FBA' || String(r.nested_code ?? '').toUpperCase().startsWith('AMAZON') || String(r.p_fm ?? '').toUpperCase() === 'FBA' || (r.fba_qty > 0) || r.fba_offer === true
const bySku = new Map<string, any[]>()
for (const r of rows) { const a = bySku.get(r.sku) ?? []; a.push(r); bySku.set(r.sku, a) }
let differing = 0
for (const [sku, rs] of bySku) {
  const verdicts = rs.map(r => `${r.marketplace}:${r.cl_fm ?? '∅'}/${r.nested_code ?? '∅'}/${r.flat_code ?? '∅'}/p=${r.p_fm ?? '∅'}/pc=${r.p_fc ?? '∅'}/fbaq=${r.fba_qty}/guard=${isFba(r) ? 'FBA' : 'FBM'}/${r.fmq ? 'FOLLOW' : 'PIN@' + (r.qo ?? r.quantity)}/q=${r.quantity}/v=${r.version}/ls=${r.ls}/pub=${r.pub}`)
  const g = new Set(rs.map(r => isFba(r) ? 'FBA' : 'FBM')); const f = new Set(rs.map(r => r.cl_fm))
  if (g.size > 1 || f.size > 1) differing++
  console.log(sku, '→', verdicts.join(' | '), (g.size > 1 || f.size > 1) ? '  ⚠ DIFFERS' : '')
}
console.log('SKUs whose Amazon EU rows differ (stored method or guard verdict):', differing, 'of', bySku.size)
console.log('\n=== GALE coordinates: channel × marketplace × alias × connection')
console.log(j(await q(`SELECT cl.channel, cl.marketplace, cl."aliasKey", cl."channelConnectionId", count(*)::int n, sum(case when cl."isPublished" then 1 else 0 end)::int published,
  string_agg(distinct cl."listingStatus", ',') statuses FROM "ChannelListing" cl JOIN "Product" c ON c.id=cl."productId" WHERE c.id=$1 OR c."parentId"=$1 GROUP BY 1,2,3,4 ORDER BY 1,2`, GALE)))
console.log('Marketplaces active:', j(await q(`SELECT channel, code, currency, region, "isActive" FROM "Marketplace" ORDER BY channel, code`)))
console.log('Connections active:', j(await q(`SELECT id, "channelType", marketplace, "isActive", "isPrimary", "accountLabel", "displayName" FROM "ChannelConnection" WHERE "isActive" ORDER BY "channelType"`)))
console.log('Policies:', j(await q(`SELECT channel, marketplace, "pushesPaused", "channelConnectionId" FROM "SyncChannelPolicy"`)))
console.log('Aliases (all):', j(await q(`SELECT count(*)::int n FROM "ProductListingAlias"`)))
console.log('GALE stock (WAREHOUSE):', j(await q(`SELECT loc.code, loc.type, loc."syncRoutes", count(*)::int rows, sum(sl.available)::int avail FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId" JOIN "Product" c ON c.id=sl."productId" WHERE c.id=$1 OR c."parentId"=$1 GROUP BY 1,2,3`, GALE)))
console.log('GALE FBA SELLABLE detail rows:', j(await q(`SELECT f."marketplaceId", f.condition, count(*)::int n, sum(f.quantity)::int qty FROM "FbaInventoryDetail" f JOIN "Product" c ON c.id=f."productId" WHERE (c.id=$1 OR c."parentId"=$1) GROUP BY 1,2 ORDER BY 1,2`, GALE)))
console.log('GALE open suppressions:', j(await q(`SELECT count(*)::int n FROM "AmazonSuppression" s JOIN "ChannelListing" cl ON cl.id=s."listingId" JOIN "Product" c ON c.id=cl."productId" WHERE (c.id=$1 OR c."parentId"=$1) AND s."resolvedAt" IS NULL`, GALE)))
console.log('GALE queue newest per (listing,type) sample:', j(await q(`SELECT q."syncType", q."syncStatus", q."isDead", count(*)::int n FROM "OutboundSyncQueue" q JOIN "ChannelListing" cl ON cl.id=q."channelListingId" JOIN "Product" c ON c.id=cl."productId" WHERE (c.id=$1 OR c."parentId"=$1) AND q."syncType" IN ('QUANTITY_UPDATE','PRICE_UPDATE') GROUP BY 1,2,3 ORDER BY 1,2`, GALE)))
console.log('GALE formulas:', j(await q(`SELECT scope, channel, marketplace, "fieldKey", count(*)::int n FROM "CellFormula" f JOIN "Product" c ON c.id=f."productId" WHERE (c.id=$1 OR c."parentId"=$1) GROUP BY 1,2,3,4`, GALE)))
console.log('GALE pricing snapshots:', j(await q(`SELECT ps.channel, ps.marketplace, count(*)::int n, sum(case when ps."isClamped" then 1 else 0 end)::int clamped FROM "PricingSnapshot" ps JOIN "Product" c ON c.sku=ps.sku WHERE (c.id=$1 OR c."parentId"=$1) GROUP BY 1,2`, GALE)))
console.log('GALE listingStatus × channel:', j(await q(`SELECT cl.channel, cl."listingStatus", cl."isPublished", count(*)::int n FROM "ChannelListing" cl JOIN "Product" c ON c.id=cl."productId" WHERE (c.id=$1 OR c."parentId"=$1) GROUP BY 1,2,3 ORDER BY 1,2,3`, GALE)))
console.log('\n=== XAVIA fixture candidates')
console.log(j(await q(`SELECT id, sku, "parentId", status, "isParent", version, "deletedAt" FROM "Product" WHERE sku ILIKE 'VX-TEST%' OR sku ILIKE 'MX-TEST%' OR sku ILIKE '%XAVIA%' ORDER BY sku LIMIT 20`)))
console.log('VX-TEST-3AX listings:', j(await q(`SELECT cl.id, c.sku, cl.channel, cl.marketplace, cl."listingStatus", cl."isPublished", cl."syncPaused", cl.version, cl."externalListingId" FROM "ChannelListing" cl JOIN "Product" c ON c.id=cl."productId" WHERE c.sku ILIKE 'VX-TEST%' ORDER BY c.sku, cl.channel, cl.marketplace`)))
console.log('\n=== (c) cached PT schema: purchasable_offer.sale_price shape (AMAZON IT OUTERWEAR)')
const sch = await q<any>(`SELECT marketplace, "productType", "schemaDefinition"->'properties'->'purchasable_offer' AS po FROM "CategorySchema" WHERE channel='AMAZON' AND "productType"='OUTERWEAR' AND marketplace='IT' AND "isActive" ORDER BY "fetchedAt" DESC LIMIT 1`)
const po = sch[0]?.po
const items = po?.items?.properties
console.log('purchasable_offer.items.properties keys:', items ? Object.keys(items) : '(none)')
console.log('sale_price:', j(items?.sale_price))
console.log('our_price:', j(items?.our_price))
console.log('audience:', j(items?.audience))
console.log('quantity_discount_plan:', j(items?.quantity_discount_plan))
console.log('required on offer item:', j(po?.items?.required))
console.log('B2B per cached schema (all AMAZON):', j(await q(`SELECT marketplace, "productType", "schemaDefinition"->'properties'->'purchasable_offer'->'items'->'properties'->'audience'->'items'->'properties'->'value'->'enum' AS audience_enum,
  ("schemaDefinition"->'properties'->'purchasable_offer'->'items'->'properties'->'quantity_discount_plan') IS NOT NULL AS has_qdp
  FROM "CategorySchema" WHERE channel='AMAZON' AND "isActive" ORDER BY marketplace, "productType"`)))
console.log('\n=== PRICE_UPDATE queue producers (payload.source distribution, local)')
console.log(j(await q(`SELECT payload->>'source' src, "syncStatus", count(*)::int n FROM "OutboundSyncQueue" WHERE "syncType"='PRICE_UPDATE' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12`)))
await p.$disconnect()
