/**
 * NEG.X action one — DISABLE `Account-wide negative sync`. Operator-approved 2026-08-14.
 *
 * 🔴 NOT a delete. `AutomationRuleExecution.rule` is `onDelete: Cascade`, so deleting the rule
 * would destroy the 16,390 execution rows that are the evidence it never worked — the ledger and
 * the weekly digest both read them. An inert rule is harmless; a hole in the audit trail is not.
 *
 * Snapshots the full row first, so the change is reversible on paper even though nothing is lost.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const NAME = 'Account-wide negative sync'
const before = await prisma.automationRule.findFirst({ where: { name: NAME } })
if (!before) { console.log('🔴 rule not found'); await prisma.$disconnect(); process.exit(1) }

console.log('─── SNAPSHOT (full row, before any change) ───────────────────────────────')
console.log(JSON.stringify(before, null, 2))

const execRows = await prisma.automationRuleExecution.count({ where: { ruleId: before.id } })
console.log(`\nexecution rows that would have been destroyed by a delete: ${execRows.toLocaleString('en-IE')}`)

if (before.enabled === false) {
  console.log('\nalready disabled — nothing to do')
} else {
  await prisma.automationRule.update({ where: { id: before.id }, data: { enabled: false } })
  console.log('\n✓ enabled → false')
}

const after = await prisma.automationRule.findUnique({ where: { id: before.id } })
console.log(`\nafter: enabled=${after?.enabled} · autonomyLevel=${after?.autonomyLevel} · trigger=${after?.trigger}`)
const stillThere = await prisma.automationRuleExecution.count({ where: { ruleId: before.id } })
console.log(`execution rows still present: ${stillThere.toLocaleString('en-IE')}  (must equal ${execRows.toLocaleString('en-IE')})`)

// the trigger must still route somewhere
const sibling = await prisma.automationRule.findFirst({
  where: { domain: 'advertising', trigger: before.trigger, enabled: true, NOT: { id: before.id } },
  select: { name: true, enabled: true, autonomyLevel: true, actions: true },
})
console.log(`\nKEYWORD_WASTED_SPEND still routes to: ${sibling ? `${sibling.name} (enabled=${sibling.enabled}, ${sibling.autonomyLevel})` : '🔴 NOTHING'}`)
await prisma.$disconnect()
