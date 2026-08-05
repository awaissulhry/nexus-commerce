/** FFT hotfix probe — time a REALISTIC 25-row save chunk through the REAL
 *  handlers (local inject, prod DB) and count queries. Local→Neon RTT inflates
 *  absolute time; the query COUNT × per-query estimate models prod. Scratch
 *  family FFT-SCRATCH-W-* only; --keep leaves it for the browser repro. */
process.env.EBAY_API_BASE = 'http://127.0.0.1:9'
delete process.env.NEXUS_EBAY_REAL_API
delete process.env.ENABLE_QUEUE_WORKERS

import Fastify from 'fastify'
const amazonRoutes = (await import('../src/routes/amazon-flat-file.routes.js')).default
const ebayRoutes = (await import('../src/routes/ebay-flat-file.routes.js')).default
const prisma = (await import('../src/db.js')).default

const KEEP = process.argv.includes('--keep')
const N = 25
const AP = 'FFT-SCRATCH-W-A-P'
const EP = 'FFT-SCRATCH-W-E-P'

let queryCount = 0
// count prisma queries via $on if available (log config dependent) — fallback: middleware
try { (prisma as any).$use(async (params: any, next: any) => { queryCount++; return next(params) }) } catch { /* $use gone in prisma 6? then skip */ }

const app = Fastify()
await app.register(amazonRoutes)
await app.register(ebayRoutes)
await app.ready()
const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) })

async function cleanup() {
  const products = await prisma.product.findMany({ where: { sku: { startsWith: 'FFT-SCRATCH-W-' } }, select: { id: true } })
  const ids = products.map((p) => p.id)
  if (!ids.length) return
  await prisma.outboundSyncQueue.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
  await prisma.sharedListingMembership.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
  await prisma.channelListing.deleteMany({ where: { productId: { in: ids } } })
  await prisma.productReadCache.deleteMany({ where: { id: { in: ids } } }).catch(() => null)
  await prisma.product.deleteMany({ where: { id: { in: ids } } })
}

try {
  await cleanup()

  // Seed via the real saves (create pre-pass) — parents first then children
  const aRows = [
    { item_sku: AP, item_name: 'Wide scratch parent', product_type: 'OUTERWEAR', parentage_level: 'parent', _isNew: true },
    ...Array.from({ length: N }, (_, i) => ({
      item_sku: `FFT-SCRATCH-W-A-C${i}`, item_name: `Wide child ${i}`, product_type: 'OUTERWEAR',
      parentage_level: 'child', parent_sku: AP, brand_name: 'FFT', color_name: 'Nero', size_name: `S${i}`, _isNew: true,
    })),
  ]
  let t = Date.now(); queryCount = 0
  const aSeed = await inject('POST', '/amazon/flat-file/sync-rows', { rows: aRows, marketplace: 'IT', productType: 'OUTERWEAR' })
  console.log(`AMZ seed(create) ${N + 1} rows: HTTP ${aSeed.statusCode} in ${Date.now() - t}ms, queries=${queryCount}`)

  // The measured chunk: 25 UPDATE rows with a content change + price + qty
  const aRows2 = aRows.slice(1).map((r, i) => ({ ...r, _isNew: undefined, item_name: `Wide child EDITED ${i}`, care_instructions: 'Hand wash', 'purchasable_offer__our_price': '19.99', 'fulfillment_availability__quantity': '3' }))
  t = Date.now(); queryCount = 0
  const aSave = await inject('POST', '/amazon/flat-file/sync-rows', { rows: aRows2, marketplace: 'IT', productType: 'OUTERWEAR' })
  const ab = aSave.json() as any
  console.log(`AMZ save(update) ${N} rows: HTTP ${aSave.statusCode} synced=${ab.synced} errors=${ab.errors?.length} in ${Date.now() - t}ms, queries=${queryCount}`)

  const eRows = [
    { sku: EP, parentage: 'parent', title: 'Wide eBay parent', variation_theme: 'Colore,Taglia', category_id: '177104' },
    ...Array.from({ length: N }, (_, i) => ({
      sku: `FFT-SCRATCH-W-E-C${i}`, parentage: 'child', parent_sku: EP,
      title: `Wide eBay child ${i}`, aspect_Colore: 'Nero', aspect_Taglia: `S${i}`, it_price: '9.99', it_qty: '2',
    })),
  ]
  t = Date.now(); queryCount = 0
  const eSeed = await inject('PATCH', '/ebay/flat-file/rows', { rows: eRows, marketplace: 'IT' })
  console.log(`EBAY seed(create) ${N + 1} rows: HTTP ${eSeed.statusCode} in ${Date.now() - t}ms, queries=${queryCount}`)

  const eRows2 = eRows.map((r, i) => ({ ...r, title: `${r.title} EDITED`, it_price: '11.50', it_qty: '4' }))
  t = Date.now(); queryCount = 0
  const eSave = await inject('PATCH', '/ebay/flat-file/rows', { rows: eRows2, marketplace: 'IT' })
  const eb = eSave.json() as any
  console.log(`EBAY save(update) ${N + 1} rows: HTTP ${eSave.statusCode} saved=${eb.saved} errors=${eb.errors?.length} in ${Date.now() - t}ms, queries=${queryCount}`)

  const parents = await prisma.product.findMany({ where: { sku: { in: [AP, EP] } }, select: { sku: true, id: true } })
  for (const p of parents) console.log(`${p.sku} id=${p.id}`)
} catch (e) {
  console.error('probe crashed:', e)
} finally {
  if (!KEEP) await cleanup().catch(() => null)
  await app.close()
  await prisma.$disconnect()
}
process.exit(0)
