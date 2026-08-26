/** BUD.8 §5 — is `set_daily_budget` (the third budget write path) reachable by any live rule? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rules = await prisma.automationRule.findMany({ select: { id: true, name: true, enabled: true, domain: true, actions: true } })
const users = rules.filter((r) => (Array.isArray(r.actions) ? r.actions : []).some((a) => ['set_daily_budget', 'budget_apply'].includes(String((a as { type?: unknown })?.type ?? ''))))
console.log(`rules total: ${rules.length}`)
console.log(`rules using set_daily_budget or budget_apply: ${users.length}`)
for (const r of users) console.log(`   ${r.enabled ? 'ON ' : 'off'} ${r.domain.padEnd(14)} ${r.name}`)
await prisma.$disconnect()
