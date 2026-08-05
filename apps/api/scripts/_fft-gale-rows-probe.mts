/** FFT-I2 — reproduce the reloaded page's GET /rows for the GALE eBay file
 *  (whole-file scope AND familyId drill-in) and count what comes back. */
process.env.EBAY_API_BASE = 'http://127.0.0.1:9'
delete process.env.NEXUS_EBAY_REAL_API
delete process.env.ENABLE_QUEUE_WORKERS

import Fastify from 'fastify'
const ebayRoutes = (await import('../src/routes/ebay-flat-file.routes.js')).default
const prisma = (await import('../src/db.js')).default

const app = Fastify({ logger: { level: "warn" } })
await app.register(ebayRoutes)
await app.ready()

const galeParent = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })

async function probe(label: string, url: string) {
  const r = await app.inject({ method: 'GET', url })
  if (r.statusCode !== 200) {
    console.log(`${label}: HTTP ${r.statusCode} — ${r.body.slice(0, 200)}`)
    return
  }
  const rows = ((r.json() as { rows?: Array<Record<string, unknown>> }).rows ?? [])
  const parents = rows.filter((x) => String(x.parentage ?? '').toLowerCase() === 'parent' || x._isParent === true)
  const shared = rows.filter((x) => x._shared === true)
  const parentSkus = [...new Set(parents.map((p) => String(p.sku)))]
  const groups = [...new Set(rows.map((x) => String(x.parent_sku ?? (String(x.parentage ?? '').toLowerCase() === 'parent' ? x.sku : ''))).filter(Boolean))]
  console.log(`${label}: rows=${rows.length} parents=${parents.length} [${parentSkus.join(', ')}] sharedRows=${shared.length} groupKeys=${groups.length} [${groups.join(', ')}]`)
}

await probe('whole-file listed IT', '/ebay/flat-file/rows?scope=listed&marketplace=IT')
await probe('whole-file all IT   ', '/ebay/flat-file/rows?scope=all&marketplace=IT')
if (galeParent) await probe('familyId drill-in   ', `/ebay/flat-file/rows?familyId=${galeParent.id}&marketplace=IT`)
await app.close()
await prisma.$disconnect()
process.exit(0)
