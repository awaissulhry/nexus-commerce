/* E7 #25 drift smoke — synthetic non-sandbox campaign + forged audit trail,
   full lifecycle: detect → accept → mutate → reapply (sandbox-mode write) →
   ad_removed → re-promote. Every row cleaned up. Local gate unset → no eBay
   calls ever fire. */
import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
const auto = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketing/ebay-ads-automation.service.js')

const EXT = 'zz-drift-smoke-ext-1'
const LID = '999000111222'
const conn = await prisma.ebayCampaign.findFirst({ where: { NOT: { externalCampaignId: { startsWith: 'sandbox-' } } }, select: { channelConnectionId: true } })
if (!conn) { console.log('FAIL: no connection id to borrow'); process.exit(1) }

let campId = ''
try {
  const camp = await prisma.ebayCampaign.create({ data: {
    channelConnectionId: conn.channelConnectionId, marketplace: 'EBAY_IT', externalCampaignId: EXT,
    name: 'zz-drift-smoke', fundingStrategy: 'COST_PER_SALE', fundingModel: 'COST_PER_SALE',
    nexusManaged: true, status: 'RUNNING', startDate: new Date(), dailyBudget: 10.0,
  } })
  campId = camp.id
  await prisma.ebayAd.create({ data: { campaignId: campId, marketplace: 'EBAY_IT', listingId: LID, bidPercentage: '3.0', status: 'ACTIVE', createdVia: 'CONSOLE' } })
  await prisma.campaignAction.create({ data: {
    channel: 'EBAY', actionType: 'bulk_update_ad_rates', entityType: 'CAMPAIGN', entityId: EXT,
    payloadBefore: {}, payloadAfter: { rates: { [LID]: 2.0 }, results: [{ key: LID, ok: true }], _mode: 'live' }, channelResponseStatus: 'SUCCESS',
  } })
  await prisma.campaignAction.create({ data: {
    channel: 'EBAY', actionType: 'set_campaign_budget', entityType: 'CAMPAIGN', entityId: EXT,
    payloadBefore: {}, payloadAfter: { dailyBudgetCents: 500, _mode: 'live' }, channelResponseStatus: 'SUCCESS',
  } })

  // 1) detect: rate 2→3 drift + budget 500→1000 drift
  let d = await auto.detectDrift(campId)
  console.log('STEP1 detect:', d.map((x) => `${x.kind} nexus=${x.nexusValue} ebay=${x.ebayValue}`).sort().join(' | '), d.length === 2 ? 'PASS' : 'FAIL')

  // 2) anomaly surfaces
  const an = await auto.detectAnomalies()
  console.log('STEP2 anomaly:', an.some((a) => a.type === 'nexus_ebay_drift') ? 'PASS (nexus_ebay_drift present)' : 'FAIL')

  // 3) accept budget drift → baseline resets
  console.log('STEP3 accept:', await auto.repairDrift(null, { campaignId: campId, kind: 'budget', action: 'accept' }))
  d = await auto.detectDrift(campId)
  console.log('STEP3 after accept:', d.length === 1 && d[0].kind === 'ad_rate' ? 'PASS (budget cleared)' : `FAIL (${d.length})`)

  // 4) reapply rate → sandbox-mode setAdRates restores mirror to 2.0
  console.log('STEP4 reapply:', await auto.repairDrift(null, { campaignId: campId, kind: 'ad_rate', listingId: LID, action: 'reapply' }))
  const ad = await prisma.ebayAd.findFirst({ where: { campaignId: campId, listingId: LID } })
  d = await auto.detectDrift(campId)
  console.log('STEP4 after reapply: mirror rate =', ad?.bidPercentage?.toString(), '| drifts:', d.length, ad?.bidPercentage?.toString() === '2' && d.length === 0 ? 'PASS' : 'CHECK')

  // 5) eBay removes the ad → ad_removed → re-promote restores it
  await prisma.ebayAd.deleteMany({ where: { campaignId: campId, listingId: LID } })
  d = await auto.detectDrift(campId)
  console.log('STEP5 removed detect:', d.length === 1 && d[0].kind === 'ad_removed' ? 'PASS' : 'FAIL')
  console.log('STEP5 re-promote:', await auto.repairDrift(null, { campaignId: campId, kind: 'ad_removed', listingId: LID, action: 'reapply' }))
  d = await auto.detectDrift(campId)
  console.log('STEP5 after re-promote: drifts =', d.length, d.length === 0 ? 'PASS' : 'FAIL')
} finally {
  const ads = await prisma.ebayAd.deleteMany({ where: { campaignId: campId } })
  const acts = await prisma.campaignAction.deleteMany({ where: { entityId: EXT } })
  const camps = await prisma.ebayCampaign.deleteMany({ where: { externalCampaignId: EXT } })
  console.log('CLEANUP:', JSON.stringify({ ads: ads.count, actions: acts.count, campaigns: camps.count }))
}
process.exit(0)
