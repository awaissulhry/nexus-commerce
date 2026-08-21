/**
 * SG.9 — one delete-me pending BID suggestion on a real AD_TARGET, so the rehoused "Pause
 * target" box in the row drawer can be verified by click. Twin: _sg9-clean-pause-check.mts.
 * Inert: it is a proposal row only — nothing runs it, and approving it is the operator's call.
 */
import prisma from '../src/db.js'
const t = await prisma.adTarget.findFirst({
  where: { status: 'ENABLED' },
  select: { id: true, expressionValue: true, adGroup: { select: { campaign: { select: { name: true, marketplace: true } } } } },
})
if (!t) { console.log('no enabled target found'); process.exit(0) }
await prisma.adsRuleSuggestion.deleteMany({ where: { ruleId: 'sg9-preview' } })
const row = await prisma.adsRuleSuggestion.create({
  data: {
    ruleId: 'sg9-preview', ruleName: 'SG.9 preview (delete me)', trigger: 'KEYWORD_HIGH_ACOS',
    marketplace: t.adGroup?.campaign?.marketplace ?? 'DE',
    entityType: 'AD_TARGET', entityId: t.id, entityName: t.expressionValue,
    proposedAction: { type: 'bid_apply', op: 'decPct', value: 10, wouldChange: 'SG.9 preview' },
    proposedKey: 'bid_apply:decPct:10', status: 'pending',
  },
})
console.log('seeded', row.id, 'target', t.expressionValue, 'in', t.adGroup?.campaign?.name)
await prisma.$disconnect()
