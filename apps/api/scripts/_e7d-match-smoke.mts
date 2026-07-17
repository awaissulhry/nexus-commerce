/* Match-queue + cost-entry smoke: real unmatched listing (sliders item),
   SYNTHETIC product, full revert. DB-only — no eBay calls exist on these
   endpoints. Also prints suggestion quality for two real listings. */
import Fastify from 'fastify'
import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
const ITEM = '256566107046' // Coppia Di Slider Ginocchia (unmatched, no SKUs)
const started = new Date()
let prodId = ''
try {
  // suggestion quality on two real listings (read-only)
  for (const it of [ITEM, '255312097005']) {
    const r = await app.inject({ method: 'GET', url: `/api/ebay-ads/products/match-candidates?itemId=${it}&marketplace=IT` })
    const top = (r.json().candidates as Array<{ sku: string; score: number }>).slice(0, 3)
    console.log(`SUGGEST ${it}:`, top.map((c) => `${c.sku}(${c.score})`).join(' | ') || 'none')
  }

  const p = await prisma.product.create({ data: { sku: 'ZZ-E7D-SMOKE', name: 'zz smoke product', basePrice: '10.00' } })
  prodId = p.id

  const m = await app.inject({ method: 'POST', url: '/api/ebay-ads/products/match', payload: { itemId: ITEM, marketplace: 'IT', productId: prodId } })
  console.log('MATCH:', m.statusCode, JSON.stringify(m.json()))

  const c = await app.inject({ method: 'POST', url: '/api/ebay-ads/products/cost', payload: { itemId: ITEM, marketplace: 'IT', costEur: 7.5 } })
  console.log('COST:', c.statusCode, JSON.stringify(c.json()))

  const eco = await prisma.ebayListingEconomics.findUnique({ where: { marketplace_itemId: { marketplace: 'IT', itemId: ITEM } } })
  console.log('ECO ROW:', eco?.dataStatus, 'cogs:', eco?.cogsCents, 'BE:', eco?.breakEvenAdRatePct?.toString(), 'price:', eco?.priceCents)

  // guard: cost on an unmatched listing must 400
  const g = await app.inject({ method: 'POST', url: '/api/ebay-ads/products/cost', payload: { itemId: '256566111017', marketplace: 'IT', costEur: 5 } })
  console.log('GUARD unmatched-cost:', g.statusCode === 400 ? 'PASS' : `FAIL ${g.statusCode}`, JSON.stringify(g.json()))
} finally {
  const um = await app.inject({ method: 'POST', url: '/api/ebay-ads/products/match', payload: { itemId: ITEM, marketplace: 'IT', productId: null } })
  console.log('REVERT unmatch:', um.statusCode, JSON.stringify(um.json()))
  if (prodId) await prisma.product.delete({ where: { id: prodId } })
  const acts = await prisma.campaignAction.deleteMany({ where: { entityId: ITEM, actionType: { in: ['match_listing', 'set_product_cost'] }, createdAt: { gte: started } } })
  const idx = await prisma.ebayListingIndex.findFirst({ where: { itemId: ITEM }, select: { productIds: true, matchStatus: true } })
  console.log('CLEANUP: actions', acts.count, '| index now:', JSON.stringify(idx))
}
process.exit(0)
