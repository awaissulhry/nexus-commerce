/** ACR.6 — is the dry-run flip actually binding, or does autonomyLevel override it? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const r = await prisma.automationRule.findUnique({
  where: { id: 'cmpujofi00018rv016th0ykq9' },
  select: { name: true, enabled: true, dryRun: true, autonomyLevel: true },
})
console.log('\nNew-to-brand optimizer:', JSON.stringify(r))

const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')
if (r) {
  const level = resolveAutonomy(r as never)
  console.log(`  resolveAutonomy → ${level}   levelActs(${level}) = ${levelActs(level)}`)
  console.log(levelActs(level)
    ? '  🔴 THIS RULE STILL WRITES. dryRun=true was ignored because autonomyLevel wins.'
    : '  ✅ this rule cannot write.')
}

const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { name: true, enabled: true, dryRun: true, autonomyLevel: true },
})
const acting = all.filter((x) => levelActs(resolveAutonomy(x as never)))
console.log(`\n${all.length} advertising rules · ${acting.length} resolve to a level that CAN write:`)
for (const x of acting) console.log(`  ${x.name.slice(0, 44).padEnd(46)} enabled=${x.enabled} dryRun=${x.dryRun} autonomyLevel=${x.autonomyLevel ?? 'null'}`)

// How many rules carry an explicit autonomyLevel at all — i.e. for how many is `dryRun` dead?
const withLevel = all.filter((x) => x.autonomyLevel != null && x.autonomyLevel !== 'OFF')
console.log(`\n${withLevel.length} of ${all.length} carry an explicit autonomyLevel — for these, toggling dryRun does NOTHING.`)

await prisma.$disconnect()
