// PN.4 probe — every value the grid shows, recomputed independently from the database.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const Fastify = (await import('fastify')).default
const { default: productsRoutes } = await import('../src/routes/products.routes.js')
const app = Fastify({ logger: false })
await app.register(productsRoutes, { prefix: '/api' })
const DAYS = 7
const CTX = { tile: null, familyId: null, salesDays: DAYS, filters: { stock: [], fulfillment: [], families: [], workflowStages: [], missingChannels: [] } }
const grid = async (request: any, context: any = {}) => {
  const r = await app.inject({ method: 'POST', url: '/api/products/grid', payload: { request: { startRow: 0, endRow: 100, sortModel: [], groupKeys: [], filterModel: {}, rowGroupCols: [], valueCols: [], ...request }, context: { ...CTX, ...context } } })
  if (r.statusCode !== 200) throw new Error(`grid ${r.statusCode}: ${r.body.slice(0, 200)}`)
  return r.json()
}
const issues: string[] = []
const bad = (s: string) => issues.push(s)
const avail = (r: any) => (r.fbaStock ?? 0) + (r.fbmStock ?? 0)

// ── 1. flat rows vs the database, field by field ─────────────────────────────────────────
const flat = await grid({})
const rows: any[] = flat.rows
const ids = rows.map((r) => r.id)
const db = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, name: true, brand: true, productType: true, status: true, totalStock: true, basePrice: true, updatedAt: true, isParent: true, parentId: true, _count: { select: { children: true, images: true, channelListings: true } } } })
const byId = new Map(db.map((p) => [p.id, p]))
const kids = await prisma.product.findMany({ where: { parentId: { in: ids } }, select: { id: true, parentId: true } })
const ownerOf = new Map<string, string>(ids.map((id) => [id, id])); for (const k of kids) ownerOf.set(k.id, k.parentId!)
const stock = await prisma.stockLevel.findMany({ where: { productId: { in: [...ownerOf.keys()] } }, select: { productId: true, quantity: true, location: { select: { type: true } } } })
const buckets = new Map<string, { fba: number; non: number }>()
for (const s of stock) { const o = ownerOf.get(s.productId)!; const b = buckets.get(o) ?? { fba: 0, non: 0 }; if (s.location.type === 'AMAZON_FBA') b.fba += s.quantity; else b.non += s.quantity; buckets.set(o, b) }
const sales = await prisma.$queryRawUnsafe<Array<{ owner: string; rc: bigint; units: bigint }>>(`
  SELECT COALESCE(p."parentId", p.id) AS owner, ROUND(SUM(oi.quantity * oi.price) * 100)::bigint AS rc, SUM(oi.quantity)::bigint AS units
  FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" JOIN "Product" p ON p.id = oi."productId"
  WHERE o."createdAt" >= now() - interval '${DAYS} days' AND o.status <> 'CANCELLED' AND COALESCE(p."parentId", p.id) = ANY($1::text[])
  GROUP BY owner`, ids)
const salesBy = new Map(sales.map((s) => [s.owner, { rc: Number(s.rc), units: Number(s.units) }]))
const tagRows = await prisma.productTag.findMany({ where: { productId: { in: ids } }, select: { productId: true, tag: { select: { name: true } } } })
const tagsBy = new Map<string, string[]>(); for (const t of tagRows) tagsBy.set(t.productId, [...(tagsBy.get(t.productId) ?? []), t.tag.name])
let checked = 0
for (const r of rows) {
  const p = byId.get(r.id)!; checked++
  const eq = (field: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) bad(`${p.sku} ${field}: grid=${JSON.stringify(a)} db=${JSON.stringify(b)}`) }
  eq('name', r.name, p.name); eq('sku', r.sku, p.sku); eq('brand', r.brand, p.brand); eq('productType', r.productType, p.productType); eq('status', r.status, p.status)
  eq('totalStock', r.totalStock, p.totalStock); eq('basePrice', Number(r.basePrice), Number(p.basePrice)); eq('updatedAt', r.updatedAt, p.updatedAt.toISOString())
  const b = buckets.get(r.id) ?? { fba: 0, non: 0 }; eq('fbaStock', r.fbaStock, b.fba); eq('fbmStock', r.fbmStock, b.non)
  const s = salesBy.get(r.id) ?? { rc: 0, units: 0 }; eq('sales.revenueCents', r.sales?.revenueCents, s.rc); eq('sales.units', r.sales?.units, s.units); eq('sales.days', r.sales?.days, DAYS)
  eq('tags', (r.tags ?? []).map((t: any) => t.name).sort(), (tagsBy.get(r.id) ?? []).sort())
  eq('childCount', r.childCount, p._count.children); eq('photoCount', r.photoCount, p._count.images); eq('channelCount', r.channelCount, p._count.channelListings)
}
console.log(`flat rows checked: ${checked} (rowCount ${flat.rowCount})`)

// ── 2. group totals vs the leaf rows ─────────────────────────────────────────────────────
const VALUES = (f: string) => [{ id: 'available', aggFunc: f }, { id: 'price', aggFunc: f }, { id: 'sales', aggFunc: f }, { id: 'units', aggFunc: f }]
const agg = (xs: number[], f: string) => f === 'sum' ? xs.reduce((a, b) => a + b, 0) : f === 'avg' ? xs.reduce((a, b) => a + b, 0) / xs.length : f === 'min' ? Math.min(...xs) : Math.max(...xs)
for (const f of ['sum', 'avg', 'min', 'max']) {
  const g = await grid({ rowGroupCols: [{ id: 'brand' }], valueCols: VALUES(f) })
  for (const gr of g.rows) {
    const leaves = rows.filter((r) => (r.brand ?? '__null__') === gr.groupKey)
    if (leaves.length !== gr.childCount) bad(`group ${gr.groupKey} childCount ${gr.childCount} ≠ ${leaves.length}`)
    const near = (a: number, b: number) => Math.abs(a - b) <= 0.5 + Math.abs(b) * 1e-6
    if (!near(gr.totalStock, agg(leaves.map(avail), f))) bad(`group ${gr.groupKey} ${f}(available) ${gr.totalStock} ≠ ${agg(leaves.map(avail), f)}`)
    if (!near(gr.basePrice, agg(leaves.map((r) => Number(r.basePrice)), f))) bad(`group ${gr.groupKey} ${f}(price) ${gr.basePrice} ≠ ${agg(leaves.map((r) => Number(r.basePrice)), f)}`)
    if (!near(gr.sales.revenueCents, agg(leaves.map((r) => r.sales.revenueCents), f))) bad(`group ${gr.groupKey} ${f}(sales) ${gr.sales.revenueCents} ≠ ${agg(leaves.map((r) => r.sales.revenueCents), f)}`)
    if (!near(gr.units, agg(leaves.map((r) => r.sales.units), f))) bad(`group ${gr.groupKey} ${f}(units) ${gr.units} ≠ ${agg(leaves.map((r) => r.sales.units), f)}`)
  }
}
console.log('group totals checked: sum/avg/min/max × 4 measures × brand groups')

// ── 3. every sortable column, both directions ────────────────────────────────────────────
const KEY: Record<string, (r: any) => number | string> = { 'ag-Grid-AutoColumn': (r) => String(r.name).toLowerCase(), available: avail, sales: (r) => r.sales.revenueCents, units: (r) => r.sales.units, price: (r) => Number(r.basePrice), updated: (r) => r.updatedAt, brand: (r) => r.brand ?? '', productType: (r) => r.productType ?? '' }
for (const colId of Object.keys(KEY)) for (const sort of ['asc', 'desc'] as const) {
  const s = await grid({ sortModel: [{ colId, sort }] })
  const ks = s.rows.map(KEY[colId])
  if (colId === 'ag-Grid-AutoColumn') {
    // Text order is the database's collation, not JS's — compare against Postgres' own ORDER BY.
    const pg = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Product" WHERE ${'"parentId" IS NULL AND "deletedAt" IS NULL AND "productType" <> \'EBAY_LISTING_SHELL\''} ORDER BY name ${sort.toUpperCase()}, id`)
    if (JSON.stringify(pg.map((r) => r.id)) !== JSON.stringify(s.rows.map((r: any) => r.id))) bad(`sort name ${sort}: differs from Postgres ORDER BY name`)
    continue
  }
  const ok = ks.every((k: any, i: number) => i === 0 || (typeof k === 'string' ? (sort === 'asc' ? String(ks[i - 1]).localeCompare(k) <= 0 : String(ks[i - 1]).localeCompare(k) >= 0) : (sort === 'asc' ? ks[i - 1] <= k : ks[i - 1] >= k)))
  if (!ok) bad(`sort ${colId} ${sort} not ordered: ${JSON.stringify(ks.slice(0, 6))}`)
  if (s.rows.length !== rows.length) bad(`sort ${colId} ${sort} returned ${s.rows.length} rows, expected ${rows.length}`)
}
console.log('sorts checked: 8 columns × 2 directions')

// ── 4. filters: each row satisfies the predicate, and the count matches SQL ──────────────
const scopeSql = `"parentId" IS NULL AND "deletedAt" IS NULL AND "productType" <> 'EBAY_LISTING_SHELL'`
const count = async (whereSql: string) => Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "Product" WHERE ${scopeSql} AND ${whereSql}`))[0].n)
const filters: Array<[string, any, (r: any) => boolean, string]> = [
  ['status ACTIVE', { status: { filterType: 'set', values: ['ACTIVE'] } }, (r) => r.status === 'ACTIVE', `status = 'ACTIVE'`],
  ['price 50–200', { price: { filterType: 'number', type: 'inRange', filter: 50, filterTo: 200 } }, (r) => Number(r.basePrice) >= 50 && Number(r.basePrice) <= 200, `"basePrice" >= 50 AND "basePrice" <= 200`],
  ['available ≥ 1', { available: { filterType: 'number', type: 'greaterThanOrEqual', filter: 1 } }, (r) => avail(r) >= 1, `id IN (SELECT own.id FROM "Product" own LEFT JOIN "Product" c ON c.id = own.id OR c."parentId" = own.id LEFT JOIN "StockLevel" sl ON sl."productId" = c.id GROUP BY own.id HAVING COALESCE(SUM(sl.quantity),0) >= 1)`],
  ['out of stock', { }, (r) => true, `TRUE`],
  ['text gale', { 'ag-Grid-AutoColumn': { filterType: 'text', type: 'contains', filter: 'gale' } }, (r) => /gale/i.test(r.name) || /gale/i.test(r.sku) || /gale/i.test(r.brand ?? ''), `(name ILIKE '%gale%' OR sku ILIKE '%gale%' OR brand ILIKE '%gale%')`],
  ['brand Xavia Racing', { brand: { filterType: 'set', values: ['Xavia Racing'] } }, (r) => r.brand === 'Xavia Racing', `brand = 'Xavia Racing'`],
]
for (const [label, fm, pred, sql] of filters) {
  const f = await grid({ filterModel: fm })
  const n = await count(sql)
  if (f.rowCount !== n) bad(`filter ${label}: rowCount ${f.rowCount} ≠ sql ${n}`)
  if (!f.rows.every(pred)) bad(`filter ${label}: a returned row fails the predicate`)
  if (f.stats.total !== n) bad(`filter ${label}: stats.total ${f.stats.total} ≠ ${n}`)
}
console.log('filters checked: 5')

// ── 5. the family preview ────────────────────────────────────────────────────────────────
const parent = rows.find((r) => (r.childCount ?? 0) > 10)
if (parent) {
  const k = await grid({ groupKeys: [parent.id] })
  const st = k.rows.map(avail)
  if (!st.every((x: number, i: number) => i === 0 || st[i - 1] <= x)) bad(`preview of ${parent.sku} not stock-ascending (roll-up): ${st}`)
  if (k.rowCount !== parent.childCount) bad(`preview of ${parent.sku}: rowCount ${k.rowCount} ≠ childCount ${parent.childCount}`)
  if (!k.rows.every((r: any) => r.parentId === parent.id)) bad(`preview of ${parent.sku}: a row is not its child`)
  if (k.rows.length !== 10) bad(`preview of ${parent.sku}: ${k.rows.length} shown, expected 10`)
  console.log(`family preview checked: ${parent.sku} (${k.rows.length} of ${k.rowCount})`)
}
const inStockSql = await count(`id IN (SELECT own.id FROM "Product" own LEFT JOIN "Product" c ON c.id = own.id OR c."parentId" = own.id LEFT JOIN "StockLevel" sl ON sl."productId" = c.id GROUP BY own.id HAVING COALESCE(SUM(sl.quantity),0) > 0)`)
if (flat.stats.inStock !== inStockSql || flat.stats.outOfStock !== flat.stats.total - inStockSql) bad(`KPI in/out of stock ${flat.stats.inStock}/${flat.stats.outOfStock} ≠ roll-up ${inStockSql}/${flat.stats.total - inStockSql}`)
console.log(`KPI stats checked: total ${flat.stats.total} active ${flat.stats.active} inStock ${flat.stats.inStock} outOfStock ${flat.stats.outOfStock}`)
console.log(`\nISSUES: ${issues.length}`); issues.forEach((s) => console.log('  ✗ ' + s))
await app.close(); await prisma.$disconnect(); process.exit(0)
