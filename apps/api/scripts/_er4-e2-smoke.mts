import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
await app.inject({ method: 'POST', url: '/api/ebay-ads/digest/generate' })
const d = (await app.inject({ method: 'GET', url: '/api/ebay-ads/digest/latest' })).json() as { digest: { payload: { week: { start: string; end: string }; totals: { adFeesCents: number }; byMarketplace: Array<{ marketplace: string; adFeesCents: number; salesCents: number; soldQty: number; acosPct: number | null }> } } }
const p = d.digest.payload
console.log('byMarketplace:', JSON.stringify(p.byMarketplace))
const splitSum = p.byMarketplace.reduce((a, m) => a + m.adFeesCents, 0)
console.log(splitSum === p.totals.adFeesCents ? '✓ split sums to totals' : `✗ FAIL split ${splitSum} vs total ${p.totals.adFeesCents}`)
const mkts = await prisma.ebayCampaign.groupBy({ by: ['marketplace'], _count: { _all: true } })
console.log('campaign marketplaces in DB:', JSON.stringify(mkts.map((m) => m.marketplace)))
process.exit(splitSum === p.totals.adFeesCents ? 0 : 1)
