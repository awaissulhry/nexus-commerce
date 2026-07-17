import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
const d = (await app.inject({ method: 'GET', url: '/api/ebay-ads/dashboard' })).json() as { recommendations: Array<{ type: string; count: number }> }
console.log('RECS:', d.recommendations.map((r) => `${r.type}=${r.count}`).join(' '))
const state = await prisma.marketingAutomationState.findUnique({ where: { channel: 'EBAY' } })
const rules = await prisma.ebayAdsRule.groupBy({ by: ['enabled'], _count: { _all: true } })
const pending = await prisma.ebayAdsProposal.count({ where: { status: 'PENDING' } })
const camps = await prisma.ebayCampaign.groupBy({ by: ['status', 'fundingModel'], _count: { _all: true } })
console.log('DIAL:', state?.globalMode, '| halted:', state?.halted, '| rules:', JSON.stringify(rules), '| pendingSuggestions:', pending)
console.log('CAMPAIGNS:', JSON.stringify(camps))
process.exit(0)
