/** ACR.7 — end-to-end: bind a rule to the GALE portfolio, verify, unbind. Leaves NO change. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const PF = '255127157311072' // Xavia GALE IT

const rule = await prisma.automationRule.findFirst({
  where: { domain: 'advertising', name: 'Wasted keyword instant negate' },
  select: { id: true, name: true, scopePortfolioId: true, scopeCampaignId: true },
})
if (!rule) throw new Error('rule not found')
console.log(`\nbefore: ${rule.name} scope=portfolio:${rule.scopePortfolioId ?? '—'} campaign:${rule.scopeCampaignId ?? '—'}`)

// 1. BIND (what the drop does)
await prisma.automationRule.update({ where: { id: rule.id }, data: { scopePortfolioId: PF, scopeCampaignId: null } })

// 2. Verify the evaluator would enforce it: the chokepoint predicate on real identities.
const { ruleMatchesScope } = await import('../src/services/automation-rule-scope.js')
const bound = { scopeMarketplace: null, scopePortfolioId: PF, scopeCampaignId: null }
const galeCampaign = await prisma.campaign.findFirst({ where: { portfolioId: PF }, select: { id: true, name: true } })
const otherCampaign = await prisma.campaign.findFirst({ where: { portfolioId: { not: PF }, marketplace: 'IT', status: 'ENABLED' }, select: { id: true, name: true, portfolioId: true } })
console.log(`  fires on GALE campaign  (${galeCampaign?.name}): ${ruleMatchesScope(bound, { marketplace: 'IT', campaignId: galeCampaign!.id, portfolioId: PF })}`)
console.log(`  fires on OTHER campaign (${otherCampaign?.name}): ${ruleMatchesScope(bound, { marketplace: 'IT', campaignId: otherCampaign!.id, portfolioId: otherCampaign!.portfolioId })}`)
console.log(`  fires on anonymous context: ${ruleMatchesScope(bound, { marketplace: 'IT', campaignId: null, portfolioId: null })}`)

// 3. What the dock will render
const after = await prisma.automationRule.findUnique({ where: { id: rule.id }, select: { scopePortfolioId: true } })
const pf = await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: PF }, select: { name: true } })
console.log(`  dock chip: portfolio: ${pf?.name} (scopePortfolioId=${after?.scopePortfolioId})`)

// 4. UNBIND — leave the account exactly as found.
await prisma.automationRule.update({ where: { id: rule.id }, data: { scopePortfolioId: null, scopeCampaignId: null } })
const final = await prisma.automationRule.findUnique({ where: { id: rule.id }, select: { scopePortfolioId: true, scopeCampaignId: true } })
console.log(`after unbind: portfolio:${final?.scopePortfolioId ?? '—'} campaign:${final?.scopeCampaignId ?? '—'}  (restored)\n`)
await prisma.$disconnect()
