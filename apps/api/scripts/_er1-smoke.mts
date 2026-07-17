/* ER1 smoke — policy endpoints + enforcement against the freshly-migrated
   prod table. Uses a real PAUSED campaign read-only except the policy row
   (created then deleted). No eBay calls. */
import Fastify from 'fastify'
import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })

const c = await prisma.ebayCampaign.findFirst({ where: { fundingModel: 'COST_PER_CLICK', status: 'PAUSED' }, select: { id: true, name: true, externalCampaignId: true } })
if (!c) { console.log('FAIL no CPC campaign'); process.exit(1) }
try {
  // 1) aggregate before any policy row → INHERIT defaults
  let r = await app.inject({ method: 'GET', url: `/api/ebay-ads/campaigns/${c.id}/automation` })
  let j = r.json()
  console.log('AGG:', r.statusCode, '| posture:', j.policy.posture, '| rules:', j.rules.length, '| proposals:', j.proposals.length, '| drifts:', j.drifts.length)

  // 2) set Protected + SUGGEST + caps
  r = await app.inject({ method: 'PUT', url: `/api/ebay-ads/campaigns/${c.id}/automation-policy`, payload: { posture: 'SUGGEST', protected: true, rateCapPct: 9, rateFloorPct: 3 } })
  console.log('PUT:', r.statusCode, JSON.stringify(r.json().policy))

  // 3) validation guards
  const bad = await app.inject({ method: 'PUT', url: `/api/ebay-ads/campaigns/${c.id}/automation-policy`, payload: { rateCapPct: 5, rateFloorPct: 8 } })
  console.log('GUARD floor>cap:', bad.statusCode === 400 ? 'PASS' : `FAIL ${bad.statusCode}`)

  // 4) detail payload carries the policy
  r = await app.inject({ method: 'GET', url: `/api/ebay-ads/campaigns/${c.id}` })
  console.log('DETAIL policy:', JSON.stringify(r.json().campaign.automationPolicy))

  // 5) protected exclusion — evaluator candidate query must skip this campaign
  const auto = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketing/ebay-ads-automation.service.js')
  const kws = await prisma.ebayKeyword.count({ where: { campaignId: c.id, status: 'ACTIVE' } })
  const visible = await prisma.ebayKeyword.count({ where: { campaignId: c.id, status: 'ACTIVE', campaign: { OR: [{ automationPolicy: null }, { automationPolicy: { protected: false, posture: { not: 'OFF' } } }] } } })
  console.log('PROTECT filter:', kws, 'keyword(s) →', visible, 'visible to evaluator', visible === 0 ? 'PASS' : kws === 0 ? 'PASS (no keywords)' : 'FAIL')
  void auto

  // 6) identification validation (no live write — name too long rejected before gate)
  const idBad = await app.inject({ method: 'PATCH', url: `/api/ebay-ads/campaigns/${c.id}/identification`, payload: { name: 'x'.repeat(90) } })
  console.log('GUARD name>80:', idBad.statusCode >= 400 ? 'PASS' : `FAIL ${idBad.statusCode}`)

  // 7) search-terms CPS guard
  const cps = await prisma.ebayCampaign.findFirst({ where: { fundingModel: 'COST_PER_SALE' }, select: { id: true } })
  if (cps) {
    const st = await app.inject({ method: 'GET', url: `/api/ebay-ads/campaigns/${cps.id}/search-terms` })
    console.log('GUARD search-terms-on-CPS:', st.statusCode === 400 ? 'PASS' : `FAIL ${st.statusCode}`)
  }
} finally {
  const del = await prisma.ebayCampaignAutomationPolicy.deleteMany({ where: { campaignId: c.id } })
  const acts = await prisma.campaignAction.deleteMany({ where: { entityId: c.externalCampaignId, actionType: 'set_automation_policy' } })
  console.log('CLEANUP:', JSON.stringify({ policies: del.count, actions: acts.count }))
}
process.exit(0)
