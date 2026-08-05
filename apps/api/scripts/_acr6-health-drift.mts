/** ACR.6 — does Alerts & Health's rule breakdown match what the engine actually resolves? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy, levelActs, levelProposes } = await import('../src/services/advertising/ads-autonomy.js')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { name: true, enabled: true, dryRun: true, autonomyLevel: true },
})

// What the health service reports today (the dead dryRun column).
const shippedLive = rules.filter((r) => r.enabled && !r.dryRun).length
const shippedDry = rules.filter((r) => r.enabled && r.dryRun).length
const disabled = rules.filter((r) => !r.enabled).length

// What the engine actually does.
const byLevel = new Map<string, number>()
for (const r of rules) {
  const l = resolveAutonomy(r as never)
  byLevel.set(l, (byLevel.get(l) ?? 0) + 1)
}
const acts = rules.filter((r) => levelActs(resolveAutonomy(r as never))).length
const proposes = rules.filter((r) => levelProposes(resolveAutonomy(r as never))).length

console.log(`\n${rules.length} advertising rules`)
console.log('\nWHAT HEALTH REPORTS TODAY (from rule.dryRun):')
console.log(`  live ............ ${shippedLive}`)
console.log(`  stuck in dry-run  ${shippedDry}`)
console.log(`  disabled ........ ${disabled}`)
console.log(`  noManaging risk . ${shippedLive === 0}`)

console.log('\nWHAT THE ENGINE RESOLVES (resolveAutonomy):')
for (const l of ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']) console.log(`  ${l.padEnd(8)} ${byLevel.get(l) ?? 0}`)
console.log(`  → can WRITE ..... ${acts}`)
console.log(`  → only proposes . ${proposes}`)

console.log('\nDRIFT:')
console.log(`  "live" overstates rules that can write by ${shippedLive - acts}`)
console.log(`  "stuck in dry-run" understates rules that cannot write by ${(rules.length - disabled - acts) - shippedDry}`)

await prisma.$disconnect()
