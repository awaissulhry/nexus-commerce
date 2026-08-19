import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// EA7 — read-only proof that the evaluator now has a DETERMINISTIC order, and a look at the
// collisions priority would actually arbitrate. Writes nothing.
const budgetRules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, trigger: true, priority: true, createdAt: true, actions: true, autonomyLevel: true },
  orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],   // ← exactly what evaluateAllRulesForTrigger does
})
const FIELD: Record<string, string> = {
  bid_to_target_acos: 'bid', bid_up: 'bid', bid_down: 'bid', lower_bid_to_floor: 'bid',
  raise_bids_for_rank_defense: 'bid', bid_apply: 'bid', dayparting_apply: 'bid',
  adjust_ad_budget: 'budget', budget_apply: 'budget',
  set_placement_multiplier: 'placement', placement_apply: 'placement', defend_top_of_search: 'placement',
}
const byTriggerField = new Map<string, string[]>()
for (const r of budgetRules) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<{ type?: string }>
  const fields = [...new Set(acts.map((a) => FIELD[String(a?.type ?? '')]).filter(Boolean))]
  for (const f of fields) {
    const k = `${r.trigger} · ${f}`
    byTriggerField.set(k, [...(byTriggerField.get(k) ?? []), `${r.priority} ${r.name.slice(0, 40)}`])
  }
}
console.log('enabled rules, in the order the evaluator now runs them:')
for (const r of budgetRules.slice(0, 6)) console.log('  ', String(r.priority).padStart(4), r.name.slice(0, 52))
console.log('\ncollisions priority can arbitrate — same trigger AND same field, >1 rule:')
let n = 0
for (const [k, v] of byTriggerField) if (v.length > 1) { n++; console.log('  ', k); for (const x of v) console.log('       ', x) }
if (n === 0) console.log('   (none within a single trigger — see the note below)')
console.log('\nfields written by >1 enabled rule ACROSS triggers (what the conflict view shows):')
const byField = new Map<string, number>()
for (const [k, v] of byTriggerField) { const f = k.split(' · ')[1]; byField.set(f, (byField.get(f) ?? 0) + v.length) }
for (const [f, c] of byField) console.log('  ', f.padEnd(10), c, 'enabled rules')
await prisma.$disconnect()
