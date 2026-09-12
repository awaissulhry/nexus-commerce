// PN.1 probe — exercise the real /api/products handler in-process (no listen, no crons) and
// check the Sales/Units server sort against an independent SQL oracle.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const Fastify = (await import('fastify')).default
const { default: productsRoutes } = await import('../src/routes/products.routes.js')
const app = Fastify({ logger: false })
await app.register(productsRoutes, { prefix: '/api' })

const base = 'includeSales=true&salesDays=90&includeTags=true&includeCoverage=true'
const get = async (qs: string) => {
  const t0 = performance.now()
  const r = await app.inject({ method: 'GET', url: `/api/products?${base}&${qs}` })
  const body = r.json()
  return { status: r.statusCode, ms: Math.round(performance.now() - t0), body, rows: (body.products ?? body.items ?? []) as any[] }
}
const rc = (p: any) => p.sales?.revenueCents ?? -1
const un = (p: any) => p.sales?.units ?? -1
// desc (-1): every step must be <= 0; asc (+1): every step must be >= 0.
const monotone = (xs: number[], dir: 1 | -1) => xs.every((x, i) => i === 0 || (x - xs[i - 1]) * dir >= 0)
// The check must be able to fail: a probe that says 'ordered' about disordered data is worthless.
if (monotone([3, 1, 2], -1) || monotone([1, 3, 2], 1) || !monotone([3, 2, 2, 1], -1) || !monotone([0, 0, 5], 1)) throw new Error('monotone() is broken')
const line = (p: any) => `${String(p.name ?? '').slice(0, 30).padEnd(30)} €${(rc(p) / 100).toFixed(2).padStart(9)} u=${String(un(p)).padStart(4)} ${p.id}`

const plain = await get('limit=8')
console.log('shape keys:', Object.keys(plain.body).join(','), '| status', plain.status, '| total', plain.body.total ?? plain.body.pagination?.total, '| plain', plain.ms + 'ms')

const d = await get('sorts=sales:desc&limit=8')
console.log(`\nsales:desc  status=${d.status} ${d.ms}ms  monotone=${monotone(d.rows.map(rc), -1)}  first>0=${rc(d.rows[0]) > 0}`)
d.rows.forEach((p) => console.log('  ' + line(p)))

const a = await get('sorts=sales:asc&limit=5')
console.log(`\nsales:asc   status=${a.status} ${a.ms}ms  monotone=${monotone(a.rows.map(rc), 1)}  firstIsZero=${rc(a.rows[0]) === 0}`)
a.rows.slice(0, 3).forEach((p) => console.log('  ' + line(p)))

const u = await get('sorts=units:desc&limit=5')
console.log(`\nunits:desc  status=${u.status} ${u.ms}ms  monotone=${monotone(u.rows.map(un), -1)}`)
u.rows.forEach((p) => console.log('  ' + line(p)))

const p2 = await get('sorts=sales:desc&limit=8&page=2')
const ids1 = new Set(d.rows.map((p) => p.id))
console.log(`\npage2       status=${p2.status} overlapWithPage1=${p2.rows.filter((p) => ids1.has(p.id)).length} boundaryOk=${rc(d.rows[d.rows.length - 1]) >= rc(p2.rows[0])} total=${p2.body.total ?? p2.body.pagination?.total} (plain ${plain.body.total ?? plain.body.pagination?.total})`)

const f = await get('sorts=sales:desc&limit=5&status=ACTIVE&search=a')
console.log(`\nfiltered    status=${f.status} allActive=${f.rows.every((p) => p.status === 'ACTIVE')} monotone=${monotone(f.rows.map(rc), -1)} n=${f.rows.length}`)
f.rows.forEach((p) => console.log('  ' + line(p)))

// Independent oracle: top 5 owners by 90-day revenue, straight from SQL, top-level & not deleted.
const oracle = await prisma.$queryRawUnsafe<Array<{ owner: string; rc: bigint; u: bigint }>>(`
  SELECT COALESCE(p."parentId", p.id) AS owner,
         ROUND(SUM(oi.quantity * oi.price) * 100)::bigint AS rc, SUM(oi.quantity)::bigint AS u
  FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" JOIN "Product" p ON p.id = oi."productId"
  JOIN "Product" own ON own.id = COALESCE(p."parentId", p.id)
  WHERE o."createdAt" >= now() - interval '90 days' AND o.status <> 'CANCELLED'
    AND own."deletedAt" IS NULL AND own."parentId" IS NULL
  GROUP BY owner ORDER BY rc DESC, owner LIMIT 5`)
const routeTop = d.rows.slice(0, 5).map((p) => `${p.id}:${rc(p)}`)
const oracleTop = oracle.map((r) => `${r.owner}:${Number(r.rc)}`)
console.log(`\noracle match (id:cents) = ${JSON.stringify(routeTop) === JSON.stringify(oracleTop)}`)
if (JSON.stringify(routeTop) !== JSON.stringify(oracleTop)) { console.log(' route :', routeTop); console.log(' oracle:', oracleTop) }

await app.close(); await prisma.$disconnect(); process.exit(0)
