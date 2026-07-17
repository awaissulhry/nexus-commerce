/* E7 Stage 2 smoke — keyword seeds + budget provenance (prefill), coverage
   guard (read-only run), summary coverage KPI, Floor Watch presence.
   READ-ONLY against prod except EbayAdsProposal upsert from runCoverageGuard
   (its designed behavior — single keyed row, PENDING). */
import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const auto = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketing/ebay-ads-automation.service.js')
const app = Fastify()
await app.register(routes, { prefix: '/api' })

// 1) hero prefill → keywordSeeds + budget
const r = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/prefill', payload: { goal: 'hero', marketplace: 'EBAY_IT' } })
const j = r.json()
console.log('hero prefill:', r.statusCode, '| seeds:', j.keywordSeeds?.length ?? 0, '| budget:', j.budget ? `€${(j.budget.suggestedCents / 100).toFixed(2)}/day` : 'null')
console.log('  top seeds:', (j.keywordSeeds ?? []).slice(0, 6).map((s: { text: string; source: string }) => `${s.text} [${s.source}]`).join(' · '))
console.log('  formula:', j.budget?.formula)

// 2) catch_all prefill must NOT carry seeds (CPS)
const r2 = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/prefill', payload: { goal: 'catch_all', marketplace: 'EBAY_IT' } })
const j2 = r2.json()
console.log('catch_all prefill:', r2.statusCode, '| seeds (expect 0):', j2.keywordSeeds?.length ?? 0, '| budget (expect null):', j2.budget)

// 3) coverage guard — creates/refreshes ONE keyed proposal
const cov = await auto.runCoverageGuard()
console.log('coverage guard:', JSON.stringify(cov))

// 4) summary carries coverage KPI
const s = await app.inject({ method: 'GET', url: '/api/ebay-ads/summary?preset=last30' })
console.log('summary coverage:', JSON.stringify(s.json().coverage))
process.exit(0)
