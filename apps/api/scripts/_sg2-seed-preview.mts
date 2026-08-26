// SG.2 — seed TWO clearly-marked preview suggestions (one AD_TARGET with real 30d perf, one
// CAMPAIGN) so the metric columns can be verified in the browser. INERT: pending rows in our own
// queue table; nothing reaches Amazon unless applied, which the verification never does.
// Cleanup: _sg2-clean-preview.mts deletes by ruleId 'sg2-preview'.
import prisma from '../src/db.js'

const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['entityId'],
  where: { entityType: 'AD_TARGET', date: { gte: since }, clicks: { gt: 0 } },
  _sum: { clicks: true, costMicros: true },
  orderBy: { _sum: { costMicros: 'desc' } },
  take: 5,
})
const target = await prisma.adTarget.findFirst({
  where: { externalTargetId: { in: perf.map((p) => p.entityId) }, status: 'ENABLED' },
  select: { id: true, bidCents: true, expressionValue: true, externalTargetId: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } },
})
const campaign = await prisma.campaign.findFirst({
  where: { status: 'ENABLED', externalCampaignId: { not: null } },
  select: { id: true, name: true, marketplace: true },
})
if (!target || !campaign) { console.log('missing subject', { target: !!target, campaign: !!campaign }); process.exit(1) }

await prisma.adsRuleSuggestion.createMany({
  data: [
    {
      ruleId: 'sg2-preview', ruleName: 'SG.2 preview (delete me)', trigger: 'KEYWORD_HIGH_ACOS',
      marketplace: target.adGroup?.campaign?.marketplace ?? 'IT',
      entityType: 'AD_TARGET', entityId: target.id, entityName: target.expressionValue,
      proposedAction: { type: 'bid_apply', op: 'decPct', value: 15, wouldChange: `${target.bidCents}¢ → ${Math.round(target.bidCents * 0.85)}¢` },
      proposedKey: 'bid_apply:decPct:15', status: 'pending',
    },
    {
      ruleId: 'sg2-preview', ruleName: 'SG.2 preview (delete me)', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
      marketplace: campaign.marketplace,
      entityType: 'CAMPAIGN', entityId: campaign.id, entityName: campaign.name,
      proposedAction: { type: 'budget_apply', op: 'incPct', value: 20, wouldChange: '€x → €y' },
      proposedKey: 'budget_apply:incPct:20', status: 'pending',
    },
  ],
})
console.log('seeded', { target: target.expressionValue, targetId: target.id, campaign: campaign.name })
process.exit(0)
