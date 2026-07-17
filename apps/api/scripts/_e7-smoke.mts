import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
const r = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/prefill', payload: { goal: 'catch_all', marketplace: 'EBAY_IT' } })
const j = r.json()
console.log('prefill:', r.statusCode, '| name:', j.derived?.name, '| listings:', j.totals?.listings, '| conflicts:', j.totals?.conflicts, '| missingCost:', j.totals?.missingCost, '| forecast €/mo:', ((j.totals?.forecastMonthlyFeeCents ?? 0) / 100).toFixed(2))
const c = (j.listings ?? []).find((l: { conflict: unknown }) => l.conflict)
console.log('sample conflict:', c ? `${c.itemId} in "${c.conflict.campaignName}"` : 'none')
const es = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/prefill', payload: { goal: 'hero', marketplace: 'EBAY_ES' } })
console.log('ES hero rejected:', es.statusCode === 400, JSON.stringify(es.json()))
process.exit(0)
