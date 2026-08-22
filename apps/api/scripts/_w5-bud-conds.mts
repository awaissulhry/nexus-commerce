/** W5 — read-only: what the budget rules actually store as conditions (decides threshold columns). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { name: true, trigger: true, enabled: true, autonomyLevel: true, conditions: true, actions: true },
})
const budget = rules.filter((r) =>
  r.trigger === 'CAMPAIGN_PERFORMANCE_BUDGET'
  || (Array.isArray(r.actions) && (r.actions as Array<{ type?: string }>).some((a) => a?.type === 'adjust_ad_budget')))
for (const r of budget) {
  console.log('BUD', JSON.stringify({ name: r.name, trigger: r.trigger, enabled: r.enabled, level: r.autonomyLevel, conditions: r.conditions }))
}
await prisma.$disconnect()
