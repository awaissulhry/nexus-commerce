// One-off: full-visibility repro of the deleted-SKU re-import silent loss.
process.env.EBAY_API_BASE = 'http://127.0.0.1:9'
delete process.env.NEXUS_EBAY_REAL_API
delete process.env.ENABLE_QUEUE_WORKERS

import Fastify from 'fastify'
const ebayRoutes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-flat-file.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default

const P = 'FFT-SCRATCH-E-PARENT'
const D = 'FFT-SCRATCH-E-DELETED'

const app = Fastify()
await app.register(ebayRoutes)
await app.ready()

const patch = (rows: unknown[], marketplace = 'IT') =>
  app.inject({ method: 'PATCH', url: '/ebay/flat-file/rows', payload: { rows, marketplace } })

try {
  // setup: parent + the to-be-deleted child, via the real save
  const s0 = await patch([
    { sku: P, parentage: 'parent', title: 'FFT parent', variation_theme: 'Colore,Taglia', category_id: '177104' },
    { sku: D, parentage: 'child', parent_sku: P, title: 'to be deleted', aspect_Colore: 'Nero', aspect_Taglia: 'L', it_price: '5.00' },
  ])
  console.log('setup:', s0.statusCode, JSON.stringify(s0.json()).slice(0, 400))
  const del = await prisma.product.updateMany({ where: { sku: D }, data: { deletedAt: new Date() } })
  console.log('soft-deleted rows:', del.count)

  // the operator's re-import of the deleted SKU
  const r = await patch([
    { sku: D, parentage: 'child', parent_sku: P, title: 'resurrected row', aspect_Colore: 'Nero', aspect_Taglia: 'L', it_price: '5.00' },
  ])
  console.log('re-import status:', r.statusCode)
  console.log('re-import FULL response:', JSON.stringify(r.json(), null, 2))

  const after = await prisma.product.findMany({ where: { sku: D }, select: { id: true, deletedAt: true } })
  console.log('DB products with that sku after:', JSON.stringify(after))

  // Case 2: a BRAND-NEW child SKU saved alone (parent exists in DB, not in payload)
  const N = 'FFT-SCRATCH-E-NEWCHILD'
  const r2 = await patch([
    { sku: N, parentage: 'child', parent_sku: P, title: 'lone new size row', aspect_Colore: 'Nero', aspect_Taglia: 'XL', it_price: '6.00' },
  ])
  const b2 = r2.json() as any
  console.log('lone-new-child status:', r2.statusCode, JSON.stringify({ saved: b2.saved, processed: b2.processed, contentOnly: b2.contentOnly, createErrors: b2.createResult?.errors, idMap: b2.createResult?.idMap }))
  const afterN = await prisma.product.findMany({ where: { sku: N }, select: { id: true } })
  console.log('DB products for lone new child:', afterN.length)
} finally {
  const products = await prisma.product.findMany({ where: { sku: { startsWith: 'FFT-SCRATCH-' } }, select: { id: true } })
  const ids = products.map((p) => p.id)
  if (ids.length) {
    await prisma.outboundSyncQueue.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
    await prisma.sharedListingMembership.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
    await prisma.channelListing.deleteMany({ where: { productId: { in: ids } } })
    await prisma.productReadCache.deleteMany({ where: { id: { in: ids } } }).catch(() => null)
    await prisma.product.deleteMany({ where: { id: { in: ids } } })
  }
  await app.close()
  await prisma.$disconnect()
}
process.exit(0) // BullMQ reconnect handles keep the process alive otherwise
