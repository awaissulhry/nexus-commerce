import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
const r = await app.inject({ method: 'GET', url: '/api/ebay-ads/campaigns?preset=last30' })
const j = r.json()
const c0 = j.campaigns[0]
console.log('CAMPAIGNS:', r.statusCode, '| rows:', j.campaigns.length)
console.log('FIELDS: automation =', JSON.stringify(c0.automation), '| limitedByBudget =', c0.limitedByBudget, '| ads =', JSON.stringify(c0.ads), '| budgetUpdatesToday =', c0.budgetUpdatesToday)
const withRules = j.campaigns.filter((x: {automation: {rules: number}}) => x.automation.rules > 0).length
console.log('RULES-BOUND campaigns:', withRules, '| limited:', j.campaigns.filter((x: {limitedByBudget: boolean}) => x.limitedByBudget).length)
const range = await app.inject({ method: 'GET', url: '/api/ebay-ads/campaigns?startDate=2026-06-01&endDate=2026-06-15' })
console.log('EXPLICIT RANGE:', range.statusCode, '| window:', JSON.stringify(range.json().window))
const s = await app.inject({ method: 'POST', url: '/api/ebay-ads/sync', payload: {} })
console.log('SYNC:', s.statusCode, '| report:', JSON.stringify(s.json().report).slice(0, 140))
process.exit(0)
