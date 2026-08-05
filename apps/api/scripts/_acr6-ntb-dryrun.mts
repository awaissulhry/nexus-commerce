/**
 * ACR.6 — stop "New-to-brand optimizer" from being able to write, before the bid_up handler fix
 * can ever let it.
 *
 * Operator decision 2026-08-05. The rule has failed every action for 30 days ("Unsupported
 * target=ad_group"). Repairing the handler could make it live in the same deploy, so it proposes
 * first: zero successful executions means zero evidence, which is exactly the bar ACR's graduation
 * doctrine sets.
 *
 * ⚠️ CORRECTED 2026-08-05: setting `dryRun` alone DID NOTHING.
 *
 * `resolveAutonomy` reads `autonomyLevel` first and only falls back to the `dryRun` binary when
 * that column is null or 'OFF'. All 51 advertising rules carry an explicit autonomyLevel, so
 * `dryRun` is a dead field for every one of them — the flip left this rule resolving to AUTO,
 * i.e. still able to write. Verified with resolveAutonomy itself rather than by reading the column.
 *
 * The real knob is autonomyLevel = 'PROPOSE': does not act, still queues suggestions, which is
 * what "let it propose for a week first" actually means.
 *
 * ONE row, instantly reversible (set autonomyLevel back to 'AUTO'). Asserts a single match before
 * writing — a name-matched update that hit two rules would be the worst outcome available here.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')

const matches = await prisma.automationRule.findMany({
  where: { domain: 'advertising', name: { contains: 'New-to-brand', mode: 'insensitive' } },
  select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true },
})

console.log(`\nmatched ${matches.length} rule(s):`)
for (const m of matches) console.log(`  ${m.id}  ${m.name}  enabled=${m.enabled} dryRun=${m.dryRun} autonomyLevel=${m.autonomyLevel ?? 'null'} → resolves ${resolveAutonomy(m as never)}`)

if (matches.length !== 1) {
  console.log('\nREFUSING to write — expected exactly one match.')
  await prisma.$disconnect()
  process.exit(1)
}

const rule = matches[0]
if (!levelActs(resolveAutonomy(rule as never))) {
  console.log('\nalready cannot write — nothing to do.')
  await prisma.$disconnect()
  process.exit(0)
}

const updated = await prisma.automationRule.update({
  where: { id: rule.id },
  // dryRun is set too, purely so the two columns do not disagree for anyone reading the row.
  // autonomyLevel is the one that binds.
  data: { autonomyLevel: 'PROPOSE', dryRun: true },
  select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true },
})
const level = resolveAutonomy(updated as never)
console.log(`\nAFTER: ${updated.name}  enabled=${updated.enabled} dryRun=${updated.dryRun} autonomyLevel=${updated.autonomyLevel}`)
console.log(`  resolveAutonomy → ${level}   canWrite=${levelActs(level)}`)
console.log(levelActs(level) ? '  🔴 STILL WRITES — do not deploy behaviour changes for this rule.' : '  ✅ it proposes; it cannot write. Revert with autonomyLevel=AUTO after reviewing a week.')

await prisma.$disconnect()
