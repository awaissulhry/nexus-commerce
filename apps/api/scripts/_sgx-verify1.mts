import '../src/env.js'
import { attachSourceLinks, attachDecisionData, attachDeliveryData, familyOfRow } from '../src/services/advertising/ads-suggestions.service.js'
import { conditionsTextOf, ruleWindowOf } from '../src/services/advertising/rule-conditions-text.js'
const { default: prisma } = await import('../src/db.js')

console.log('══════ PENDING (starting bid + placement pair + window) ══════')
const pend = await prisma.adsRuleSuggestion.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } })
const pFull = await attachDecisionData(await attachSourceLinks(pend as any) as any)
const rules = await prisma.automationRule.findMany({ where: { id: { in: [...new Set(pend.map(r=>r.ruleId))] } }, select: { id:true, conditions:true } })
const byRule = new Map(rules.map(r=>[r.id,r]))
for (const r of pFull as any[]) {
  const rule = byRule.get(r.ruleId)
  console.log(familyOfRow(r).padEnd(13), (r.entityName ?? '').slice(0,28).padEnd(29),
    'current=', JSON.stringify(r.current),
    'suggested=', JSON.stringify({bidCents:r.suggested.bidCents, bidCentsMax:r.suggested.bidCentsMax, budgetEur:r.suggested.budgetEur, placementPct:r.suggested.placementPct}))
  console.log('   reason :', conditionsTextOf(rule?.conditions))
  console.log('   window :', ruleWindowOf(rule?.conditions))
}

console.log('\n══════ APPLIED (historical truth) ══════')
const app = await prisma.adsRuleSuggestion.findMany({ where: { status: 'applied' }, orderBy: { decidedAt: 'desc' } })
const aFull = await attachDeliveryData(await attachDecisionData(await attachSourceLinks(app as any) as any) as any)
for (const r of aFull as any[]) {
  console.log(familyOfRow(r).padEnd(9), (r.entityName ?? '').padEnd(24))
  console.log('   wouldChange   :', (r.proposedAction as any)?.wouldChange)
  console.log('   appliedChange :', JSON.stringify(r.appliedChange))
  console.log('   delivery      :', JSON.stringify(r.delivery))
  console.log('   (stale proj)  : current', JSON.stringify(r.current.dailyBudgetEur), '→ suggested', JSON.stringify(r.suggested.budgetEur))
}
await prisma.$disconnect()
