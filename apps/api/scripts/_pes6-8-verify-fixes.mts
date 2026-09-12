/**
 * PES.6 — prove ruling #29's two fixes, rather than asserting them.
 *  1. importing the barrel must not touch Redis (measure the import with an UNREACHABLE Redis)
 *  2. resolveBatch must issue ONE FieldLinkGroup query for N products, not N
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../.env', import.meta.url).pathname })

// Point Redis at a black hole so a lazy import is the only thing that can survive.
process.env.REDIS_URL = 'redis://127.0.0.1:6399'
process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:6399'

console.log('--- 1. import the barrel with Redis unreachable ---')
const t0 = Date.now()
const mod = await import('../src/services/pim/mapping/index.js')
console.log(`imported in ${Date.now() - t0}ms; exports: ${Object.keys(mod).length}`)
if (Date.now() - t0 > 8000) { console.log('FAIL: import blocked'); process.exit(1) }

console.log('\n--- 2. count FieldLinkGroup queries for a multi-product batch ---')
const { default: prisma } = await import('../src/db.js')
const family = await prisma.product.findMany({
  where: { OR: [{ sku: 'GALE-JACKET' }, { parent: { sku: 'GALE-JACKET' } }] },
  select: { id: true, sku: true },
})
console.log(`family size: ${family.length} products`)

let linkGroupQueries = 0
let totalQueries = 0
prisma.$on('query' as never, (e: any) => {
  totalQueries++
  if (typeof e.query === 'string' && e.query.includes('FieldLinkGroup')) linkGroupQueries++
})

const t1 = Date.now()
const res = await mod.resolveChannelValues({
  channel: 'AMAZON', marketplace: 'IT',
  productIds: family.map((p) => p.id),
  fieldKeys: ['item_name', 'brand', 'list_price'],
  productType: 'OUTERWEAR',
})
console.log(`resolved ${Object.keys(res.byProduct).length} products in ${Date.now() - t1}ms`)
console.log(`FieldLinkGroup queries: ${linkGroupQueries}  (was 1 per product = ${family.length})`)
console.log(`total queries: ${totalQueries}`)
console.log(linkGroupQueries <= 1 ? 'PASS — batched' : `FAIL — ${linkGroupQueries} queries`)

const first = Object.values(res.byProduct)[0] as any
console.log('\nsample cell:', JSON.stringify(first?.item_name)?.slice(0, 160))
await prisma.$disconnect()
process.exit(0)
