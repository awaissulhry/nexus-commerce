/**
 * READ-ONLY audit for F1 (buildFlatRow channelListings[0] cross-market bleed)
 * and F7 (shared-membership row synthesis ignores marketplace).
 * No writes. No eBay calls.
 */
const { default: prisma } = await import('../src/db.js')

function j(v: unknown) { return JSON.stringify(v) }

// ── 1. eBay ChannelListing landscape ────────────────────────────────────────
const byRegion = await prisma.channelListing.groupBy({
  by: ['region', 'listingStatus'],
  where: { channel: 'EBAY' },
  _count: { _all: true },
})
console.log('\n=== [1] eBay ChannelListing by region x status ===')
for (const r of byRegion.sort((a, b) => (a.region + a.listingStatus).localeCompare(b.region + b.listingStatus))) {
  console.log(`  ${r.region.padEnd(4)} ${String(r.listingStatus).padEnd(12)} ${r._count._all}`)
}

// ── 2. Products with eBay listings in >1 region (F1 blast radius) ───────────
const multi = await prisma.$queryRawUnsafe<Array<{
  productId: string; sku: string; regions: string; n: bigint
}>>(`
  SELECT p.id AS "productId", p.sku,
         string_agg(DISTINCT cl.region, ',' ORDER BY cl.region) AS regions,
         COUNT(*) AS n
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId"
  WHERE cl.channel = 'EBAY' AND p."deletedAt" IS NULL
  GROUP BY p.id, p.sku
  HAVING COUNT(DISTINCT cl.region) > 1
  ORDER BY p.sku
`)
console.log(`\n=== [2] Products with eBay listings in >1 region: ${multi.length} ===`)
for (const m of multi) console.log(`  ${m.sku.padEnd(34)} regions=${m.regions} listings=${m.n}`)

// ── 3. For those products: does the NON-IT listing carry DIFFERENT itemSpecifics? ─
console.log('\n=== [3] Cross-market itemSpecifics / title divergence (F1 payload) ===')
for (const m of multi) {
  const cls = await prisma.channelListing.findMany({
    where: { productId: m.productId, channel: 'EBAY' },
    select: {
      id: true, region: true, externalListingId: true, listingStatus: true,
      title: true, price: true, quantity: true, updatedAt: true, platformAttributes: true,
    },
    orderBy: { updatedAt: 'desc' },
  })
  console.log(`\n  ${m.sku}`)
  for (const c of cls) {
    const pa = (c.platformAttributes ?? {}) as Record<string, unknown>
    const isp = (pa.itemSpecifics ?? {}) as Record<string, string>
    const keys = Object.keys(isp)
    console.log(`    region=${String(c.region).padEnd(3)} status=${String(c.listingStatus).padEnd(10)} itemId=${c.externalListingId ?? '-'} upd=${c.updatedAt.toISOString().slice(0, 16)}`)
    console.log(`      title=${j((c.title ?? '').slice(0, 60))}`)
    console.log(`      cat=${String(pa.categoryId ?? '')} aspects(${keys.length})=${j(keys.slice(0, 12))}`)
    if (keys.length) console.log(`      sample=${j(Object.fromEntries(Object.entries(isp).slice(0, 6)))}`)
  }
}

// ── 4. Which listing would buildFlatRow pick with NO sort (buildEbayFamilyRows /
//      loadSharedMembershipRows path)? Prisma default order = no ORDER BY. ─────
console.log('\n=== [4] Unsorted findMany order for the multi-region products (what [0] becomes) ===')
for (const m of multi.slice(0, 20)) {
  const p = await prisma.product.findMany({
    where: { id: m.productId },
    include: { channelListings: { where: { channel: 'EBAY' } } },
  })
  const order = (p[0]?.channelListings ?? []).map((c) => `${c.region}${c.externalListingId ? '#' + c.externalListingId : ''}`)
  console.log(`  ${m.sku.padEnd(34)} [0]=${order[0]}  all=${j(order)}`)
}

// ── 5. SharedListingMembership landscape (F7) ───────────────────────────────
const mByMp = await prisma.sharedListingMembership.groupBy({
  by: ['marketplace', 'status'],
  _count: { _all: true },
})
console.log('\n=== [5] SharedListingMembership by marketplace x status ===')
for (const r of mByMp) console.log(`  ${r.marketplace.padEnd(4)} ${r.status.padEnd(8)} ${r._count._all}`)

// ── 6. Parent SKUs carrying memberships in MORE THAN ONE marketplace (F7 bleed) ─
const crossMp = await prisma.$queryRawUnsafe<Array<{ parentSku: string; mps: string; n: bigint }>>(`
  SELECT "parentSku", string_agg(DISTINCT marketplace, ',' ORDER BY marketplace) AS mps, COUNT(*) AS n
  FROM "SharedListingMembership"
  WHERE status = 'ACTIVE'
  GROUP BY "parentSku"
  HAVING COUNT(DISTINCT marketplace) > 1
  ORDER BY "parentSku"
`)
console.log(`\n=== [6] parentSku with ACTIVE memberships in >1 marketplace: ${crossMp.length} ===`)
for (const r of crossMp) console.log(`  ${r.parentSku.padEnd(34)} mps=${r.mps} n=${r.n}`)

// ── 7. dedup collision: same (parentSku, sku) in >1 marketplace → only ONE row
//      survives loadSharedMembershipRows today, and WHICH one is arbitrary. ────
const dedupCollide = await prisma.$queryRawUnsafe<Array<{ parentSku: string; sku: string; mps: string; itemIds: string }>>(`
  SELECT "parentSku", sku,
         string_agg(DISTINCT marketplace, ',' ORDER BY marketplace) AS mps,
         string_agg(DISTINCT "itemId", ',' ORDER BY "itemId") AS "itemIds"
  FROM "SharedListingMembership"
  WHERE status = 'ACTIVE'
  GROUP BY "parentSku", sku
  HAVING COUNT(DISTINCT marketplace) > 1
  ORDER BY "parentSku", sku
`)
console.log(`\n=== [7] (parentSku,sku) pairs whose ACTIVE memberships span >1 marketplace: ${dedupCollide.length} ===`)
for (const r of dedupCollide.slice(0, 40)) console.log(`  ${r.parentSku}|${r.sku} mps=${r.mps} itemIds=${r.itemIds}`)

// ── 8. Same (parentSku,sku) under MULTIPLE itemIds within ONE marketplace —
//      the legitimate pool-sibling case that the dedup key ALREADY collapses. ──
const sameMpMultiItem = await prisma.$queryRawUnsafe<Array<{ marketplace: string; parentSku: string; sku: string; itemIds: string }>>(`
  SELECT marketplace, "parentSku", sku,
         string_agg(DISTINCT "itemId", ',' ORDER BY "itemId") AS "itemIds"
  FROM "SharedListingMembership"
  WHERE status = 'ACTIVE'
  GROUP BY marketplace, "parentSku", sku
  HAVING COUNT(DISTINCT "itemId") > 1
  ORDER BY marketplace, "parentSku", sku
`)
console.log(`\n=== [8] same marketplace+parentSku+sku under >1 itemId (already dedup-collapsed today): ${sameMpMultiItem.length} ===`)
for (const r of sameMpMultiItem.slice(0, 30)) console.log(`  ${r.marketplace} ${r.parentSku}|${r.sku} itemIds=${r.itemIds}`)

// ── 9. The REAL pool model: one sku under many itemIds (different parentSkus) ──
const poolSpread = await prisma.$queryRawUnsafe<Array<{ marketplace: string; sku: string; parents: string; n: bigint }>>(`
  SELECT marketplace, sku,
         string_agg(DISTINCT "parentSku", ',' ORDER BY "parentSku") AS parents,
         COUNT(DISTINCT "itemId") AS n
  FROM "SharedListingMembership"
  WHERE status = 'ACTIVE'
  GROUP BY marketplace, sku
  HAVING COUNT(DISTINCT "itemId") > 1
  ORDER BY COUNT(DISTINCT "itemId") DESC
  LIMIT 15
`)
console.log('\n=== [9] pool model check — one sku across many itemIds/parents (MUST keep all) ===')
for (const r of poolSpread) console.log(`  ${r.marketplace} ${r.sku.padEnd(28)} itemIds=${r.n} parents=${r.parents}`)

// ── 10. Do membership child products have an IT ChannelListing? (blank price) ──
const memIT = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { marketplace: true, productId: true, sku: true, parentSku: true, price: true },
})
const pids = [...new Set(memIT.map((m) => m.productId).filter((v): v is string => !!v))]
const prods = await prisma.product.findMany({
  where: { id: { in: pids } },
  select: { id: true, sku: true, channelListings: { where: { channel: 'EBAY' }, select: { region: true, price: true } } },
})
const regionsByPid = new Map(prods.map((p) => [p.id, new Set(p.channelListings.map((c) => c.region))]))
let noITListing = 0, nullPrice = 0, nullProductId = 0
for (const m of memIT) {
  if (!m.productId) { nullProductId++; continue }
  const rg = regionsByPid.get(m.productId)
  if (!rg?.has('IT')) noITListing++
  if (m.price == null) nullPrice++
}
console.log('\n=== [10] blank-price risk for synthesized rows ===')
console.log(`  ACTIVE memberships: ${memIT.length}`)
console.log(`  with productId = null (no childBaseRow at all → every non-mp column blank): ${nullProductId}`)
console.log(`  child product has NO IT ChannelListing (it_price/it_qty come out null): ${noITListing}`)
console.log(`  membership.price = null (no ${'${mp}'}_price override written): ${nullPrice}`)

// ── 11. IT-file baseline: row counts per family (the regression assertion) ─────
console.log('\n=== [11] BASELINE — parents + ACTIVE membership rows per parentSku, per marketplace ===')
const perParent = await prisma.$queryRawUnsafe<Array<{ marketplace: string; parentSku: string; skus: bigint }>>(`
  SELECT marketplace, "parentSku", COUNT(DISTINCT sku) AS skus
  FROM "SharedListingMembership"
  WHERE status = 'ACTIVE'
  GROUP BY marketplace, "parentSku"
  ORDER BY marketplace, "parentSku"
`)
for (const r of perParent) console.log(`  ${r.marketplace} ${r.parentSku.padEnd(34)} distinctSkus=${r.skus}`)

// ── 12. F6 sanity — DE ChannelListing carrying an IT ItemID ────────────────────
const dupItemIds = await prisma.$queryRawUnsafe<Array<{ externalListingId: string; regions: string; skus: string }>>(`
  SELECT cl."externalListingId",
         string_agg(DISTINCT cl.region, ',' ORDER BY cl.region) AS regions,
         string_agg(DISTINCT p.sku, ',' ORDER BY p.sku) AS skus
  FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
  WHERE cl.channel='EBAY' AND cl."externalListingId" IS NOT NULL AND cl."externalListingId" <> ''
  GROUP BY cl."externalListingId"
  HAVING COUNT(DISTINCT cl.region) > 1
  ORDER BY cl."externalListingId"
`)
console.log(`\n=== [12] eBay ItemIDs present on ChannelListings in >1 region (F6): ${dupItemIds.length} ===`)
for (const r of dupItemIds) console.log(`  itemId=${r.externalListingId} regions=${r.regions} skus=${r.skus}`)

await prisma.$disconnect()
