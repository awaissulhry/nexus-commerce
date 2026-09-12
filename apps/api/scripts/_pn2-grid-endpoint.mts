// PN.2 probe — POST /api/products/grid in-process (no listen, no crons), checked against
// GET /api/products (same listProducts underneath) and an independent SQL oracle.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const Fastify = (await import('fastify')).default
const { default: productsRoutes } = await import('../src/routes/products.routes.js')
const app = Fastify({ logger: false })
await app.register(productsRoutes, { prefix: '/api' })

const EMPTY = { channels: [], status: [], stock: [], fulfillment: [], productTypes: [], brands: [], tags: [], families: [], workflowStages: [], missingChannels: [], priceMin: '', priceMax: '', stockMin: '', stockMax: '' }
const grid = async (request: any, context: any = {}) => {
  const t0 = performance.now()
  const r = await app.inject({ method: 'POST', url: '/api/products/grid', payload: { request: { startRow: 0, endRow: 100, sortModel: [], groupKeys: [], ...request }, context: { search: '', tile: null, familyId: null, salesDays: 90, filters: EMPTY, ...context } } })
  return { status: r.statusCode, ms: Math.round(performance.now() - t0), body: r.json() }
}
const get = async (qs: string) => { const r = await app.inject({ method: 'GET', url: `/api/products?includeSales=true&salesDays=90&includeTags=true&includeCoverage=true&${qs}` }); return { status: r.statusCode, body: r.json() } }
const rc = (p: any) => p.sales?.revenueCents ?? -1
const un = (p: any) => p.sales?.units ?? -1
const monotone = (xs: number[], dir: 1 | -1) => xs.every((x, i) => i === 0 || (x - xs[i - 1]) * dir >= 0)
if (monotone([3, 1, 2], -1) || monotone([1, 3, 2], 1) || !monotone([3, 2, 2, 1], -1)) throw new Error('monotone() is broken')
const line = (p: any) => `${String(p.name ?? '').slice(0, 30).padEnd(30)} €${(rc(p) / 100).toFixed(2).padStart(9)} u=${String(un(p)).padStart(4)} ${p.id}`

const d = await grid({ sortModel: [{ colId: 'sales', sort: 'desc' }], endRow: 8 })
console.log(`grid sales:desc  status=${d.status} ${d.ms}ms keys=${Object.keys(d.body).join(',')} rowCount=${d.body.rowCount} monotone=${monotone(d.body.rows.map(rc), -1)} unsupported=${JSON.stringify(d.body.unsupported)}`)
d.body.rows.forEach((p: any) => console.log('  ' + line(p)))
const g = await get('sorts=sales:desc&limit=8')
console.log(`GET parity (same ids in same order) = ${JSON.stringify(g.body.products.map((p: any) => p.id)) === JSON.stringify(d.body.rows.map((p: any) => p.id))}`)

const u = await grid({ sortModel: [{ colId: 'units', sort: 'asc' }], endRow: 5 })
console.log(`\ngrid units:asc   status=${u.status} monotone=${monotone(u.body.rows.map(un), 1)} first=${un(u.body.rows[0])}`)
const p2 = await grid({ sortModel: [{ colId: 'sales', sort: 'desc' }], startRow: 8, endRow: 16 })
const ids1 = new Set(d.body.rows.map((p: any) => p.id))
console.log(`page 2          status=${p2.status} rows=${p2.body.rows.length} overlap=${p2.body.rows.filter((p: any) => ids1.has(p.id)).length} boundaryOk=${rc(d.body.rows[7]) >= rc(p2.body.rows[0])} rowCount=${p2.body.rowCount}`)

const auto = await grid({ sortModel: [{ colId: 'ag-Grid-AutoColumn', sort: 'asc' }], endRow: 5 })
const names = auto.body.rows.map((p: any) => String(p.name).toLowerCase())
console.log(`\nProduct header  status=${auto.status} nameAsc=${names.every((n: string, i: number) => i === 0 || names[i - 1].localeCompare(n) <= 0)}`)

const parent = d.body.rows.find((p: any) => p.isParent || (p.childCount ?? 0) > 10)
if (parent) {
  const kids = await grid({ groupKeys: [parent.id], sortModel: [{ colId: 'price', sort: 'desc' }] }, { search: 'ignored', filters: { ...EMPTY, status: ['ZZZ'] } })
  const stocks = kids.body.rows.map((p: any) => p.totalStock)
  console.log(`\nexpand family   status=${kids.status} shown=${kids.body.rows.length} rowCount=${kids.body.rowCount} (parent childCount=${parent.childCount}) allChildrenOfParent=${kids.body.rows.every((p: any) => p.parentId === parent.id)} stockAsc=${monotone(stocks, 1)} cappedAt10=${kids.body.rows.length <= 10}`)
}

const t = await grid({ sortModel: [{ colId: 'tags', sort: 'desc' }] }, { tile: 'active', filters: { ...EMPTY, tags: ['no-such-tag-xyz'], families: ['no-such-family'] } })
console.log(`\nunsupported     status=${t.status} rowCount=${t.body.rowCount} allActive=${t.body.rows.every((p: any) => p.status === 'ACTIVE')} unsupported=${JSON.stringify(t.body.unsupported)}`)

const oracle = await prisma.$queryRawUnsafe<Array<{ owner: string; rc: bigint }>>(`
  SELECT COALESCE(p."parentId", p.id) AS owner, ROUND(SUM(oi.quantity * oi.price) * 100)::bigint AS rc
  FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" JOIN "Product" p ON p.id = oi."productId"
  JOIN "Product" own ON own.id = COALESCE(p."parentId", p.id)
  WHERE o."createdAt" >= now() - interval '90 days' AND o.status <> 'CANCELLED' AND own."deletedAt" IS NULL AND own."parentId" IS NULL
  GROUP BY owner ORDER BY rc DESC, owner LIMIT 5`)
console.log(`\noracle top-5 match = ${JSON.stringify(oracle.map((r) => `${r.owner}:${Number(r.rc)}`)) === JSON.stringify(d.body.rows.slice(0, 5).map((p: any) => `${p.id}:${rc(p)}`))}`)
await app.close(); await prisma.$disconnect(); process.exit(0)
