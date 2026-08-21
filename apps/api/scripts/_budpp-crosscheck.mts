import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { previewBudgetRule } = await import('../src/services/advertising/ads-rule-preview.service.js')
const id = 'cmt3byq3i00arl901dwu06y4u'
const rule = await prisma.automationRule.findUnique({ where: { id }, select: { name: true, actions: true, conditions: true, scopeMarketplace: true } })
if (!rule) { console.log('rule gone'); process.exit(1) }

const out = await previewBudgetRule({ actions: rule.actions, conditions: rule.conditions, scopeMarketplace: rule.scopeMarketplace })
console.log(`PREVIEW of "${rule.name}"  ok=${out.ok} window=${out.windowDays}d`)
console.log(`  selected=${out.selected} · measurable=${out.measurable} · inScope=${out.inScope} · matched=${out.matched} · noChange=${out.noChange}`)
for (const r of out.rows) console.log(`  ${r.marketplace} ${r.campaign.padEnd(24)} EUR${r.currentEur.toFixed(2)} -> EUR${r.proposedEur.toFixed(2)} (util ${r.budgetUtilizationPct}%)${r.clamped ? ' [clamped]' : ''}`)

const sugg = await prisma.adsRuleSuggestion.findMany({ where: { ruleId: id }, select: { entityName: true, proposedAction: true } })
console.log(`\nWHAT THE ENGINE ACTUALLY PROPOSED (${sugg.length}):`)
const eng = new Map<string, string>()
for (const s of sugg) {
  const c = await prisma.campaign.findUnique({ where: { id: String((s.proposedAction as Record<string, unknown>).campaignId) }, select: { name: true, dailyBudget: true } })
  const a = s.proposedAction as Record<string, unknown>
  console.log(`  ${c?.name} op=${a.op} value=${a.value} (current EUR${c?.dailyBudget})`)
  if (c) eng.set(c.name, String(a.op) + ':' + String(a.value))
}
const pv = new Set(out.rows.map(r => r.campaign))
const same = eng.size === pv.size && [...eng.keys()].every(k => pv.has(k))
console.log(`\nSAME CAMPAIGN SET? ${same ? 'YES' : 'NO'}  preview=[${[...pv].sort().join(', ')}]  engine=[${[...eng.keys()].sort().join(', ')}]`)
await prisma.$disconnect()
