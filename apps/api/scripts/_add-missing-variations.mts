/** Owner intent: full size range on all 5 listings. Adds missing variations live. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { addVariationsToListing } = await import('../src/services/ebay-variation-add.service.js')
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')

// token via a tiny harness call is overkill — use the auth service directly
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
if (!conn) throw new Error('no eBay connection')
const token = await ebayAuthService.getValidToken(conn.id)

// Pool = the 20 dash-SKU children of the primary family
const pool = await prisma.product.findMany({
  where: { parentId: 'cmokmy3a40078pm0p1fvnu523', deletedAt: null, sku: { contains: '-MEN-' }, NOT: { sku: { endsWith: '-REAL' } } },
  select: { id: true, sku: true },
})
const specificsFromSku = (sku: string) => {
  const m = /^GALE-JACKET-(BLACK|YELLOW)-MEN-(.+)$/.exec(sku)
  if (!m) return null
  return { Colore: m[1] === 'BLACK' ? 'Nero' : 'Giallo', Taglia: m[2], Color: m[1] === 'BLACK' ? 'Nero' : 'Giallo', Size: m[2] }
}
const qtyByProduct = new Map<string, number>()
for (const p of pool) {
  const agg = await prisma.stockLevel.aggregate({ where: { productId: p.id, location: { type: 'WAREHOUSE' } }, _sum: { available: true } })
  qtyByProduct.set(p.id, Math.max(0, agg._sum.available ?? 0))
}

for (const itemId of ['257584954808', '256564203510', '256566101420', '256566102729', '256566103703']) {
  const mem = await prisma.sharedListingMembership.findMany({ where: { marketplace: 'IT', itemId }, select: { sku: true, price: true } })
  const have = new Set(mem.map((m) => m.sku))
  const price = Number(mem.find((m) => m.price != null)?.price ?? 105)
  const candidates = pool
    .filter((p) => !have.has(p.sku))
    .map((p) => ({ sku: p.sku, price, quantity: qtyByProduct.get(p.id) ?? 0, specifics: specificsFromSku(p.sku)! }))
    .filter((c) => c.specifics)
  if (candidates.length === 0) { console.log(`${itemId}: complete already`); continue }
  try {
    const r = await addVariationsToListing(itemId, 'IT', candidates, { oauthToken: token })
    console.log(`${itemId}: added=${r.added} skippedExisting=${r.skippedExisting} ack=${r.ebayAck} memberships+${r.membershipsCreated}`)
  } catch (err) {
    console.log(`${itemId}: ERROR ${err instanceof Error ? err.message.slice(0, 250) : err}`)
  }
}
// Read-back verification
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
for (const itemId of ['257584954808', '256564203510', '256566101420', '256566102729', '256566103703']) {
  const v = await app.inject({ method: 'GET', url: `/ebay/flat-file/verify-item?itemId=${itemId}&marketplace=IT` })
  const d = v.json() as any
  console.log(`verify ${itemId}: variants=${d.ebayVariantCount} matched=${d.matched}/${d.memberships} missing=${(d.missingOnEbay ?? []).length}`)
}
await app.close(); await prisma.$disconnect(); process.exit(0)
