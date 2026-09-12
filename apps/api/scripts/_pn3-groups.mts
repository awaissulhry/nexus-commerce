// PN.3 probe — grouped levels of POST /api/products/grid in-process, against an SQL oracle.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const Fastify = (await import('fastify')).default
const { default: productsRoutes } = await import('../src/routes/products.routes.js')
const app = Fastify({ logger: false })
await app.register(productsRoutes, { prefix: '/api' })
const CTX = { tile: null, familyId: null, salesDays: 90, filters: { stock: [], fulfillment: [], families: [], workflowStages: [], missingChannels: [] } }
const grid = async (request: any, context: any = {}) => {
  const t0 = performance.now()
  const r = await app.inject({ method: 'POST', url: '/api/products/grid', payload: { request: { startRow: 0, endRow: 100, sortModel: [], groupKeys: [], filterModel: {}, rowGroupCols: [], valueCols: [], ...request }, context: { ...CTX, ...context } } })
  return { status: r.statusCode, ms: Math.round(performance.now() - t0), body: r.json() }
}
const by = (ids: string[]) => ids.map((id) => ({ id, displayName: id }))
const VALUES = [{ id: 'sales', aggFunc: 'sum' }, { id: 'units', aggFunc: 'sum' }, { id: 'available', aggFunc: 'sum' }, { id: 'price', aggFunc: 'avg' }]

const g1 = await grid({ rowGroupCols: by(['brand']), valueCols: VALUES })
console.log(`groups by brand  status=${g1.status} ${g1.ms}ms rowCount=${g1.body.rowCount} stats=${JSON.stringify(g1.body.stats)} unsupported=${JSON.stringify(g1.body.unsupported)}`)
for (const r of g1.body.rows) console.log(`  ${String(r.groupKey).padEnd(14)} n=${String(r.childCount).padStart(3)} stock=${String(r.totalStock).padStart(6)} avgPrice=${Number(r.basePrice).toFixed(2).padStart(8)} sales=€${(r.sales.revenueCents / 100).toFixed(2).padStart(10)} units=${r.sales.units} id=${r.id}`)
const oracle = await prisma.$queryRawUnsafe<Array<{ key: string; n: bigint; stock: bigint; avg_price: number; rc: bigint; units: bigint }>>(`
  WITH tl AS (SELECT p.id, COALESCE(p.brand, '__null__') AS key, p."totalStock", p."basePrice" FROM "Product" p WHERE p."parentId" IS NULL AND p."deletedAt" IS NULL AND p."productType" <> 'EBAY_LISTING_SHELL'),
  s AS (SELECT tl.id, COALESCE(SUM(CASE WHEN o.id IS NULL THEN 0 ELSE oi.quantity * oi.price END),0) AS rev, COALESCE(SUM(CASE WHEN o.id IS NULL THEN 0 ELSE oi.quantity END),0) AS units
        FROM tl LEFT JOIN "Product" c ON c.id = tl.id OR c."parentId" = tl.id LEFT JOIN "OrderItem" oi ON oi."productId" = c.id
        LEFT JOIN "Order" o ON o.id = oi."orderId" AND o."createdAt" >= now() - interval '90 days' AND o.status <> 'CANCELLED' GROUP BY tl.id)
  SELECT tl.key, COUNT(*)::bigint AS n, SUM(tl."totalStock")::bigint AS stock, AVG(tl."basePrice")::float AS avg_price, ROUND(SUM(s.rev) * 100)::bigint AS rc, SUM(s.units)::bigint AS units
  FROM tl LEFT JOIN s ON s.id = tl.id GROUP BY tl.key ORDER BY tl.key`)
const srv = g1.body.rows.map((r: any) => `${r.groupKey}|${r.childCount}|${r.totalStock}|${Number(r.basePrice).toFixed(2)}|${r.sales.revenueCents}|${r.sales.units}`).sort()
const orc = oracle.map((r) => `${r.key}|${Number(r.n)}|${Number(r.stock)}|${Number(r.avg_price).toFixed(2)}|${Number(r.rc)}|${Number(r.units)}`).sort()
console.log(`oracle match = ${JSON.stringify(srv) === JSON.stringify(orc)}`); if (JSON.stringify(srv) !== JSON.stringify(orc)) { console.log(' server:', srv); console.log(' oracle:', orc) }

const flat = await grid({})
console.log(`stats equal to the flat list = ${JSON.stringify(flat.body.stats) === JSON.stringify(g1.body.stats)} (flat rowCount ${flat.body.rowCount})`)

const first = g1.body.rows[0]
const g2 = await grid({ rowGroupCols: by(['brand', 'productType']), groupKeys: [first.groupKey], valueCols: VALUES })
console.log(`\ninside "${first.groupKey}" by type  status=${g2.status} rowCount=${g2.body.rowCount} childSum=${g2.body.rows.reduce((n: number, r: any) => n + r.childCount, 0)} (parent n=${first.childCount})`)
for (const r of g2.body.rows) console.log(`  ${String(r.groupKey).padEnd(16)} n=${r.childCount} sales=€${(r.sales.revenueCents / 100).toFixed(2)}`)

const leaf = await grid({ rowGroupCols: by(['brand', 'productType']), groupKeys: [first.groupKey, g2.body.rows[0].groupKey] })
console.log(`\nleaf level  status=${leaf.status} rows=${leaf.body.rows.length} rowCount=${leaf.body.rowCount} allInGroup=${leaf.body.rows.every((p: any) => (p.brand ?? '__null__') === first.groupKey && (p.productType ?? '__null__') === g2.body.rows[0].groupKey)} isGroupRow=${!!leaf.body.rows[0]?.__group}`)

const sorted = await grid({ rowGroupCols: by(['brand']), valueCols: VALUES, sortModel: [{ colId: 'sales', sort: 'desc' }] })
const cents = sorted.body.rows.map((r: any) => r.sales.revenueCents)
console.log(`\nsorted by sum(sales) desc  monotone=${cents.every((x: number, i: number) => i === 0 || cents[i - 1] >= x)} ${JSON.stringify(cents)}`)

const filtered = await grid({ rowGroupCols: by(['status']), valueCols: [{ id: 'available', aggFunc: 'max' }], filterModel: { price: { filterType: 'number', type: 'inRange', filter: 50, filterTo: 200 } } })
console.log(`\ngroups by status, price 50–200  rowCount=${filtered.body.rowCount} ${filtered.body.rows.map((r: any) => `${r.groupKey}:${r.childCount}:max=${r.totalStock}`).join(' ')} statsTotal=${filtered.body.stats.total}`)
await app.close(); await prisma.$disconnect(); process.exit(0)
