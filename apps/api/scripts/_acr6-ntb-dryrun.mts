/**
 * ACR.6 — put "New-to-brand optimizer" into dry-run BEFORE the bid_up handler fix ships.
 *
 * Operator decision 2026-08-05. The rule is enabled with dryRun=false and has failed every action
 * for 30 days ("Unsupported target=ad_group"). Repairing the handler would make it live in the same
 * deploy, so it proposes first: zero successful executions means zero evidence, which is exactly
 * the bar ACR's graduation doctrine sets.
 *
 * ONE field, ONE row, instantly reversible (set dryRun back to false). Asserts a single match
 * before writing — a name-matched update that hit two rules would be the worst possible outcome.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const matches = await prisma.automationRule.findMany({
  where: { domain: 'advertising', name: { contains: 'New-to-brand', mode: 'insensitive' } },
  select: { id: true, name: true, enabled: true, dryRun: true },
})

console.log(`\nmatched ${matches.length} rule(s):`)
for (const m of matches) console.log(`  ${m.id}  ${m.name}  enabled=${m.enabled} dryRun=${m.dryRun}`)

if (matches.length !== 1) {
  console.log('\nREFUSING to write — expected exactly one match.')
  await prisma.$disconnect()
  process.exit(1)
}

const rule = matches[0]
if (rule.dryRun) {
  console.log('\nalready dryRun=true — nothing to do.')
  await prisma.$disconnect()
  process.exit(0)
}

const updated = await prisma.automationRule.update({
  where: { id: rule.id },
  data: { dryRun: true },
  select: { id: true, name: true, enabled: true, dryRun: true },
})
console.log(`\nAFTER: ${updated.id}  ${updated.name}  enabled=${updated.enabled} dryRun=${updated.dryRun}`)
console.log('It will now PROPOSE instead of writing. Revert with dryRun=false when you have seen a week of proposals.')

await prisma.$disconnect()
