import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
const r = await app.inject({ method: 'GET', url: '/api/ebay-ads/reconciliation' })
console.log('RECON:', r.statusCode, '| drifts on prod:', r.json().drifts.length)
const a = await app.inject({ method: 'GET', url: '/api/ebay-ads/actions?entityId=zz-nonexistent&limit=5' })
console.log('ACTIONS filter:', a.statusCode, '| rows:', a.json().actions.length)
const p = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/prefill', payload: { goal: 'catch_all', marketplace: 'EBAY_IT' } })
console.log('PREFILL activeCampaigns:', p.json().activeCampaigns)
process.exit(0)
