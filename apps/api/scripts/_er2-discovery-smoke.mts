/* ER2 discovery smoke — full ladder lifecycle against the fresh table:
   launch w/ rateDiscovery (sandbox) → evaluator proposes step 1 → approve →
   rates set + plan advances → dwell fast-forward → window recorded + step 2
   proposed → rollback halts. Synthetic ads; full cleanup. */
import Fastify from 'fastify'
import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const auto = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketing/ebay-ads-automation.service.js')
const app = Fastify()
await app.register(routes, { prefix: '/api' })
let campId = ''
try {
  const r = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/launch', payload: {
    goal: 'catch_all', name: 'zz-er2-discovery', marketplace: 'EBAY_IT',
    items: [{ listingId: '256566101420', ratePct: 4, resolution: 'include' }, { listingId: '256566103703', ratePct: 4, resolution: 'include' }],
    rateDiscovery: { floorPct: 3, capPct: 5, stepPct: 1, dwellDays: 7 },
    rulePacks: [],
  } })
  const j = r.json()
  campId = j.campaignId
  console.log('LAUNCH:', r.statusCode, '| armed:', j.rateDiscoveryArmed, '| promote ok:', (j.promoteResults as Array<{ ok: boolean }>).filter((x) => x.ok).length)
  await prisma.ebayCampaign.update({ where: { id: campId }, data: { status: 'RUNNING' } }) // sandbox launches aren't RUNNING; simulate a live one

  // evaluator tick 1 → proposes floor step
  let out = await auto.evaluateRateDiscovery()
  console.log('TICK1:', JSON.stringify(out))
  let prop = await prisma.ebayAdsProposal.findUnique({ where: { proposedKey: `discovery:${campId}` } })
  console.log('STEP1 proposal:', prop?.kind, '| to:', (prop?.proposedAction as { to?: string })?.to)

  // approve step 1 → rates set + plan advances
  const dec = await auto.decideProposals(null, [prop!.id], 'approve')
  console.log('APPROVE1:', JSON.stringify(dec.map((d: { ok: boolean; detail?: string }) => ({ ok: d.ok, detail: d.detail }))))
  const ad = await prisma.ebayAd.findFirst({ where: { campaignId: campId }, select: { bidPercentage: true } })
  let plan = await prisma.ebayRateDiscoveryPlan.findUnique({ where: { campaignId: campId } })
  console.log('AFTER1: ad rate =', ad?.bidPercentage?.toString(), '| plan current =', plan?.currentPct?.toString())

  // fast-forward dwell → tick 2 records window + proposes 4%
  await prisma.ebayRateDiscoveryPlan.update({ where: { campaignId: campId }, data: { lastStepAt: new Date(Date.now() - 8 * 86_400_000) } })
  out = await auto.evaluateRateDiscovery()
  console.log('TICK2:', JSON.stringify(out))
  plan = await prisma.ebayRateDiscoveryPlan.findUnique({ where: { campaignId: campId } })
  prop = await prisma.ebayAdsProposal.findUnique({ where: { proposedKey: `discovery:${campId}` } })
  console.log('STEP2: history windows =', (plan?.history as unknown[]).length, '| proposal to:', (prop?.proposedAction as { to?: string })?.to)

  // approve step 2 then ROLL IT BACK → rates restored + plan HALTED
  const dec2 = await auto.decideProposals(null, [prop!.id], 'approve')
  console.log('APPROVE2:', dec2[0]?.ok, dec2[0]?.detail)
  const rb = await auto.rollbackProposal(null, prop!.id)
  plan = await prisma.ebayRateDiscoveryPlan.findUnique({ where: { campaignId: campId } })
  const ad2 = await prisma.ebayAd.findFirst({ where: { campaignId: campId }, select: { bidPercentage: true } })
  console.log('ROLLBACK:', rb, '| plan status:', plan?.status, '| ad rate back to:', ad2?.bidPercentage?.toString())
} finally {
  if (campId) {
    await prisma.ebayRateDiscoveryPlan.deleteMany({ where: { campaignId: campId } })
    await prisma.ebayAdsProposal.deleteMany({ where: { proposedKey: `discovery:${campId}` } })
    const ads = await prisma.ebayAd.deleteMany({ where: { campaignId: campId } })
    const ext = (await prisma.ebayCampaign.findUnique({ where: { id: campId }, select: { externalCampaignId: true } }))?.externalCampaignId
    if (ext) await prisma.campaignAction.deleteMany({ where: { entityId: ext } })
    const camps = await prisma.ebayCampaign.deleteMany({ where: { id: campId } })
    console.log('CLEANUP:', JSON.stringify({ ads: ads.count, campaigns: camps.count }))
  }
}
process.exit(0)
