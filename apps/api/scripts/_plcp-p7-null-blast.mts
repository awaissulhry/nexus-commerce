/**
 * PLC-P7 side-finding — how far does `Number(null) === 0` reach? Read-only.
 *
 * `applyOperator` (automation-rule.service.ts:97) implements `lte` as `Number(lhs) <= Number(rhs)`.
 * `Number(null)` is 0, so a NULL metric matches every `lte` and every `lt` — the exact behaviour
 * the context builders' own comments say nulls exist to prevent.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { applyOperator } = await import('../src/services/automation-rule.service.js')
const { buildCampaignBudgetContexts } = await import('../src/jobs/advertising-rule-evaluator.job.js')

console.log('── the comparator, in isolation ──')
for (const [op, v] of [['lte', 0.2], ['lt', 0.2], ['gte', 0.2], ['gt', 0.2]] as const) {
  console.log(`  null      ${op.padEnd(4)} ${v}  → ${applyOperator(op as never, null, v)}`)
}
for (const [op, v] of [['lte', 0.2], ['lt', 0.2]] as const) {
  console.log(`  undefined ${op.padEnd(4)} ${v}  → ${applyOperator(op as never, undefined, v)}   ← how PLC-P7's lane fields behave`)
}

console.log('\n── the reach, on this account ──')
const ctxs = await buildCampaignBudgetContexts(7)
const noAcos = ctxs.filter((c) => c.campaign.acos == null)
const noCtr = ctxs.filter((c) => c.campaign.ctr == null)
const noCvr = ctxs.filter((c) => c.campaign.cvr == null)
console.log(`  campaigns emitting a context (7 settled days):        ${ctxs.length}`)
console.log(`  …with acos = null (spend, but NO attributed sales):   ${noAcos.length}`)
console.log(`  …with ctr  = null:                                    ${noCtr.length}`)
console.log(`  …with cvr  = null (clicks but no orders):             ${noCvr.length}`)

const wouldMatch = noAcos.filter((c) => applyOperator('lte' as never, c.campaign.acos, 0.25)).length
console.log(`\n🔴 a rule reading "ACoS ≤ 25%" matches ${wouldMatch} of those ${noAcos.length} zero-sale campaigns —`)
console.log(`   i.e. a "back the winners" rule would raise budgets/bids on campaigns that have sold NOTHING.`)
const cvrMatch = noCvr.filter((c) => applyOperator('lte' as never, c.campaign.cvr, 0.02)).length
console.log(`   a rule reading "CVR ≤ 2%" matches ${cvrMatch} of the ${noCvr.length} campaigns with no orders.`)

const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising', enabled: true }, select: { name: true, conditions: true, autonomyLevel: true } })
const exposed = rules.filter((r) => JSON.stringify(r.conditions).match(/"op":"(lte|lt)"/))
console.log(`\n  enabled advertising rules carrying a lt/lte condition today: ${exposed.length} of ${rules.length}`)
for (const r of exposed) console.log(`    · "${r.name}" [${r.autonomyLevel}]`)
console.log('\n  (All are PROPOSE, so nothing writes on this today — a human sees each suggestion first.)')
await prisma.$disconnect()
