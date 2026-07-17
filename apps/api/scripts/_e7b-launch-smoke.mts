/* E7 Stage 2 launch smoke — SANDBOX mode (NEXUS_MARKETING_WRITES_EBAY unset
   locally): CPC launch with keywords (step 3b) + clone rematerialization,
   then full cleanup of every row created. No eBay API calls. */
import Fastify from 'fastify'
import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
const created: string[] = [] // campaign ids to clean

try {
  // 1) CPC launch with keyword seeds
  const r = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/launch', payload: {
    goal: 'hero', name: 'zz-e7b-smoke-hero', marketplace: 'EBAY_IT',
    dailyBudgetCents: 500, targetingType: 'MANUAL', items: [],
    keywords: [{ text: 'giacca moto', matchType: 'PHRASE', bidCents: 30 }, { text: 'guanti moto', matchType: 'EXACT', bidCents: 25 }],
    rulePacks: ['Keyword bleeder — pause (CPC)'],
  } })
  const j = r.json()
  if (j.campaignId) created.push(j.campaignId)
  const kwOk = (j.keywordResults ?? []).filter((x: { ok: boolean }) => x.ok).length
  console.log('LAUNCH:', r.statusCode, '| mode:', j.mode, '| keywords ok:', kwOk, '/2 | packs bound:', (j.rulePacksBound ?? []).length)
  console.log('LAUNCH timeline:', (j.timeline ?? []).join(' | '))

  // 2) clone it → rematerialization counts
  const c = await app.inject({ method: 'POST', url: `/api/ebay-ads/campaigns/${j.campaignId}/clone`, payload: { name: 'zz-e7b-smoke-hero-clone' } })
  const cj = c.json()
  if (cj.campaignId) created.push(cj.campaignId)
  console.log('CLONE:', c.statusCode, '| counts:', JSON.stringify(cj.counts))
} finally {
  // 3) cleanup — children first, campaigns last; scoped rules too
  if (created.length) {
    const kw = await prisma.ebayKeyword.deleteMany({ where: { campaignId: { in: created } } })
    const ng = await prisma.ebayNegativeKeyword.deleteMany({ where: { campaignId: { in: created } } })
    const gr = await prisma.ebayAdGroup.deleteMany({ where: { campaignId: { in: created } } })
    const ads = await prisma.ebayAd.deleteMany({ where: { campaignId: { in: created } } })
    const rules = await prisma.ebayAdsRule.deleteMany({ where: { OR: created.map((id) => ({ scope: { path: ['campaignIds'], array_contains: id } })) } })
    const acts = await prisma.campaignAction.deleteMany({ where: { entityId: { in: (await prisma.ebayCampaign.findMany({ where: { id: { in: created } }, select: { externalCampaignId: true } })).map((x) => x.externalCampaignId) } } }).catch(() => ({ count: -1 }))
    const camps = await prisma.ebayCampaign.deleteMany({ where: { id: { in: created } } })
    console.log('CLEANUP:', JSON.stringify({ keywords: kw.count, negatives: ng.count, groups: gr.count, ads: ads.count, rules: rules.count, actions: acts.count, campaigns: camps.count }))
  }
}
process.exit(0)
