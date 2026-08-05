/**
 * READ-ONLY follow-up: sizing the ONLY behaviour change a strict market-scoped
 * `first` would cause — rows that would render content-blank because the product
 * has NO ChannelListing in the active market. Plus the IT-file row baseline.
 */
const { default: prisma } = await import('../src/db.js')

// ── A. Per market: products with an eBay listing there vs NOT there ─────────
const rows = await prisma.$queryRawUnsafe<Array<{ region: string; n: bigint }>>(`
  SELECT region, COUNT(DISTINCT "productId") AS n
  FROM "ChannelListing" WHERE channel='EBAY' GROUP BY region ORDER BY region
`)
console.log('=== [A] distinct products with an eBay listing, per region ===')
for (const r of rows) console.log(`  ${r.region}: ${r.n}`)

// Products that have an eBay listing in SOME region but NOT in IT → these are
// the ONLY rows that could newly render blank on the IT file under strict scoping.
const notIT = await prisma.$queryRawUnsafe<Array<{ sku: string; regions: string }>>(`
  SELECT p.sku, string_agg(DISTINCT cl.region, ',' ORDER BY cl.region) AS regions
  FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
  WHERE cl.channel='EBAY' AND p."deletedAt" IS NULL
  GROUP BY p.id, p.sku
  HAVING SUM(CASE WHEN cl.region='IT' THEN 1 ELSE 0 END) = 0
  ORDER BY p.sku
`)
console.log(`\n=== [B] products with an eBay listing but NONE in IT: ${notIT.length} ===`)
for (const r of notIT.slice(0, 50)) console.log(`  ${r.sku} regions=${r.regions}`)

// Mirror for DE (the only other market with rows).
const notDE = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
  SELECT COUNT(*) AS n FROM (
    SELECT p.id FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl.channel='EBAY' AND p."deletedAt" IS NULL
    GROUP BY p.id HAVING SUM(CASE WHEN cl.region='DE' THEN 1 ELSE 0 END)=0
  ) t
`)
console.log(`\n=== [C] products with an eBay listing but NONE in DE: ${notDE[0].n} (would blank on a DE file) ===`)

// ── D. Duplicate (productId, region) eBay listings — would make even a
//      region-scoped .find() ambiguous. ─────────────────────────────────────
const dupes = await prisma.$queryRawUnsafe<Array<{ sku: string; region: string; n: bigint }>>(`
  SELECT p.sku, cl.region, COUNT(*) AS n
  FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
  WHERE cl.channel='EBAY'
  GROUP BY p.sku, cl.region HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC
`)
console.log(`\n=== [D] duplicate (product, region) eBay ChannelListings: ${dupes.length} ===`)
for (const d of dupes.slice(0, 20)) console.log(`  ${d.sku} ${d.region} x${d.n}`)

// ── E. IT-file BASELINE — products the scoped query loads + membership rows ──
const scopeWhere = {
  deletedAt: null,
  OR: [
    { channelListings: { some: { channel: 'EBAY', marketplace: 'IT' } } },
    { parent: { channelListings: { some: { channel: 'EBAY', marketplace: 'IT' } } } },
    { children: { some: { channelListings: { some: { channel: 'EBAY', marketplace: 'IT' } } } } },
  ],
} as const
const scoped = await prisma.product.findMany({
  where: scopeWhere,
  select: { id: true, sku: true, parentId: true },
  orderBy: { sku: 'asc' },
})
console.log(`\n=== [E] IT scope=listed products loaded by GET /rows: ${scoped.length} ===`)
const parents = scoped.filter((p) => !p.parentId)
console.log(`  parent rows (_isParent=true): ${parents.length}`)

const parentSkus = parents.map((p) => p.sku).filter(Boolean)
const memAll = await prisma.sharedListingMembership.findMany({
  where: { parentSku: { in: parentSkus }, status: 'ACTIVE' },
  select: { sku: true, parentSku: true, marketplace: true },
})
const memIT = memAll.filter((m) => m.marketplace === 'IT')
const parentIdBySku = new Map(parents.map((p) => [p.sku, p.id]))
const normalKeys = new Set(scoped.map((p) => `${p.parentId ?? p.id}|${p.sku}`))
function synthCount(list: typeof memAll) {
  const existing = new Set(normalKeys)
  let n = 0
  for (const m of list) {
    const pid = parentIdBySku.get(m.parentSku)
    if (!pid) continue
    const k = `${pid}|${m.sku}`
    if (existing.has(k)) continue
    existing.add(k)
    n++
  }
  return n
}
console.log(`\n=== [F] synthesized shared rows on the IT file ===`)
console.log(`  memberships matched to a parent row (ALL marketplaces, TODAY): ${memAll.length}`)
console.log(`  memberships matched to a parent row (IT only, PROPOSED):      ${memIT.length}`)
console.log(`  synthesized rows TODAY   : ${synthCount(memAll)}`)
console.log(`  synthesized rows PROPOSED: ${synthCount(memIT)}`)
console.log(`  → TOTAL IT file rows TODAY   : ${scoped.length + synthCount(memAll)}`)
console.log(`  → TOTAL IT file rows PROPOSED: ${scoped.length + synthCount(memIT)}`)

// per-family breakdown (the "row counts per family must be identical" assertion)
const byFam = new Map<string, { normal: number; synthToday: number; synthProp: number }>()
for (const p of scoped) {
  const fk = p.parentId ?? p.id
  const e = byFam.get(fk) ?? { normal: 0, synthToday: 0, synthProp: 0 }
  e.normal++
  byFam.set(fk, e)
}
function tally(list: typeof memAll, key: 'synthToday' | 'synthProp') {
  const existing = new Set(normalKeys)
  for (const m of list) {
    const pid = parentIdBySku.get(m.parentSku)
    if (!pid) continue
    const k = `${pid}|${m.sku}`
    if (existing.has(k)) continue
    existing.add(k)
    const e = byFam.get(pid) ?? { normal: 0, synthToday: 0, synthProp: 0 }
    e[key]++
    byFam.set(pid, e)
  }
}
tally(memAll, 'synthToday')
tally(memIT, 'synthProp')
const skuById = new Map(scoped.map((p) => [p.id, p.sku]))
console.log('\n=== [G] per-family row counts (normal + synthesized) today vs proposed ===')
let diffs = 0
for (const [fk, e] of [...byFam.entries()].sort((a, b) => String(skuById.get(a[0])).localeCompare(String(skuById.get(b[0]))))) {
  const today = e.normal + e.synthToday
  const prop = e.normal + e.synthProp
  const flag = today === prop ? '' : '   <<< DIFF'
  if (today !== prop) diffs++
  console.log(`  ${String(skuById.get(fk) ?? fk).padEnd(36)} today=${String(today).padEnd(4)} proposed=${String(prop).padEnd(4)}${flag}`)
}
console.log(`\n  families with a row-count difference: ${diffs}`)

await prisma.$disconnect()
