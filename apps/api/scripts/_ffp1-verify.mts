// FFP.1 live verification — exercises the REAL route handlers against prod DB
// on a throwaway scratch family (created + cleaned up here). Read/write is
// confined to the FFP1-VERIFY-* scratch rows.
import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-flat-file.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default

const app = Fastify()
await app.register(routes, { prefix: '/api' })

const PARENT_SKU = 'FFP1-VERIFY-PARENT'
const CHILD_SKU = 'FFP1-VERIFY-CHILD'
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

// ── setup: scratch family (direct prisma, no route side effects) ──
await prisma.channelListing.deleteMany({ where: { product: { sku: { startsWith: 'FFP1-VERIFY-' } } } })
await prisma.product.deleteMany({ where: { sku: { startsWith: 'FFP1-VERIFY-' } } })
const parent = await prisma.product.create({
  data: { sku: PARENT_SKU, name: 'FFP1 verify parent', isParent: true, status: 'DRAFT', basePrice: 0 },
})
const child = await prisma.product.create({
  data: { sku: CHILD_SKU, name: 'FFP1 verify child', parentId: parent.id, status: 'DRAFT', basePrice: 0 },
})

try {
  // ── 1. content-only save (no market columns at all) ──
  const contentRow = {
    _rowId: child.id, _productId: child.id, sku: CHILD_SKU,
    platformProductId: parent.id, parentage: 'child', parent_sku: PARENT_SKU,
    title: 'FFP1 verify title', aspect_Colore: 'VerifyNero', aspect_Taglia: 'XL',
    category_id: '57988',
  }
  const patch1 = await app.inject({
    method: 'PATCH', url: '/api/ebay/flat-file/rows',
    payload: { rows: [contentRow], marketplace: 'IT' },
  })
  const p1 = patch1.json() as { saved: number; processed: number; contentOnly: number }
  console.log('\n[1] content-only save (previously silently dropped):')
  check('HTTP 200', patch1.statusCode === 200, String(patch1.statusCode))
  check('saved=1 (row actually written)', p1.saved === 1, JSON.stringify(p1))
  check('contentOnly=1 (fallback path used)', p1.contentOnly === 1, JSON.stringify(p1))

  const draftListing = await prisma.channelListing.findFirst({
    where: { productId: child.id, channel: 'EBAY', region: 'IT' },
  })
  check('DRAFT IT listing created', draftListing?.listingStatus === 'DRAFT')
  const snap = (draftListing?.flatFileSnapshot ?? {}) as Record<string, unknown>
  check('snapshot holds aspect_Colore', snap.aspect_Colore === 'VerifyNero')

  // ── 2. reload round-trip ──
  const get1 = await app.inject({
    method: 'GET',
    url: `/api/ebay/flat-file/rows?familyId=${parent.id}&scope=all&marketplace=IT`,
  })
  const rows1 = (get1.json() as { rows: Array<Record<string, unknown>> }).rows
  const childRow1 = rows1.find((r) => r.sku === CHILD_SKU)
  console.log('\n[2] reload round-trip:')
  check('child row present', !!childRow1)
  check('aspect_Colore survives reload', childRow1?.aspect_Colore === 'VerifyNero', String(childRow1?.aspect_Colore))
  check('aspect_Taglia survives reload', childRow1?.aspect_Taglia === 'XL')
  check('title survives reload', childRow1?.title === 'FFP1 verify title')
  check('category_id survives reload', String(childRow1?.category_id) === '57988')

  // ── 3. typed price wins + live hint ──
  const priceRow = { ...contentRow, it_price: 85 }
  const patch2 = await app.inject({
    method: 'PATCH', url: '/api/ebay/flat-file/rows',
    payload: { rows: [priceRow], marketplace: 'IT' },
  })
  console.log('\n[3] typed price + live divergence hint:')
  check('price save HTTP 200', patch2.statusCode === 200)

  // simulate the repricer moving the live price after the operator saved
  await prisma.channelListing.updateMany({
    where: { productId: child.id, channel: 'EBAY', region: 'IT' },
    data: { price: 99 },
  })
  const get2 = await app.inject({
    method: 'GET',
    url: `/api/ebay/flat-file/rows?familyId=${parent.id}&scope=all&marketplace=IT`,
  })
  const childRow2 = (get2.json() as { rows: Array<Record<string, unknown>> }).rows
    .find((r) => r.sku === CHILD_SKU)
  check('typed price (85) wins over live (99)', Number(childRow2?.it_price) === 85, String(childRow2?.it_price))
  check('_live_price_it hint = 99', Number(childRow2?._live_price_it) === 99, String(childRow2?._live_price_it))

  // ── 4. legacy caller (no marketplace) unchanged: no crash, price write ──
  const patch3 = await app.inject({
    method: 'PATCH', url: '/api/ebay/flat-file/rows',
    payload: { rows: [{ ...contentRow, it_price: 85 }] },
  })
  console.log('\n[4] legacy caller (no marketplace in body):')
  check('HTTP 200', patch3.statusCode === 200)
} finally {
  // ── cleanup: remove every scratch artifact ──
  // productEvent emits are fire-and-forget; give them a beat to land or the
  // product delete hits an FK on a row inserted after our deleteMany.
  await new Promise((r) => setTimeout(r, 1500))
  const listings = await prisma.channelListing.findMany({
    where: { product: { sku: { startsWith: 'FFP1-VERIFY-' } } },
    select: { id: true },
  })
  const ids = listings.map((l) => l.id)
  if (ids.length) {
    await prisma.outboundSyncQueue.deleteMany({ where: { channelListingId: { in: ids } } })
  }
  await prisma.channelListing.deleteMany({ where: { id: { in: ids } } })
  await prisma.stockMovement.deleteMany({ where: { product: { sku: { startsWith: 'FFP1-VERIFY-' } } } })
  await prisma.stockLevel.deleteMany({ where: { product: { sku: { startsWith: 'FFP1-VERIFY-' } } } })
  await prisma.productEvent.deleteMany({ where: { aggregateId: { in: [parent.id, child.id] } } }).catch(() => {})
  await prisma.product.deleteMany({ where: { sku: { startsWith: 'FFP1-VERIFY-' } } })
  console.log('\ncleanup done')
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
