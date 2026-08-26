/** RA.AUTO — state of the write-path test subject, before and after. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')
const { graduationCeiling } = await import('../src/services/advertising/ads-graduation.js')

const NAME = process.env.RA7_RULE ?? '__E_probe_KEYWORD_HIGH_ACOS__'
const r = await prisma.automationRule.findFirst({
  where: { domain: 'advertising', name: NAME },
  select: {
    id: true, name: true, trigger: true, enabled: true, dryRun: true, autonomyLevel: true,
    actions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true,
    evaluationCount: true, matchCount: true, executionCount: true, lastExecutedAt: true,
  },
})
if (!r) { console.log(`rule "${NAME}" not found`); process.exit(0) }
const types = (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? ''))
const pc = await prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
const ceiling = graduationCeiling({ actionTypes: types, hasKeywordProtections: pc > 0 })

console.log(`\n${r.name}`)
console.log(`  id           ${r.id}`)
console.log(`  trigger      ${r.trigger}`)
console.log(`  actions      ${types.join(', ')}   ← non-writing only means it cannot reach Amazon at ANY level`)
console.log(`  enabled      ${r.enabled}`)
console.log(`  dryRun       ${r.dryRun}`)
console.log(`  autonomyLvl  ${r.autonomyLevel}`)
console.log(`  RESOLVED     ${resolveAutonomy(r)}`)
console.log(`  ceiling      ${ceiling.maxLevel}${ceiling.blockedBy ? ` (blockedBy=${ceiling.blockedBy})` : ''}`)
console.log(`  scope        marketplace=${r.scopeMarketplace} portfolio=${r.scopePortfolioId} campaign=${r.scopeCampaignId}`)
console.log(`  counters     evals=${r.evaluationCount} matches=${r.matchCount} execs=${r.executionCount} lastRun=${r.lastExecutedAt?.toISOString() ?? 'never'}`)

// A rule capped below AUTO, to verify the server's 409 refusal path.
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' }, select: { id: true, name: true, actions: true, enabled: true, dryRun: true, autonomyLevel: true },
})
const capped = all.find((x) => {
  const t = (Array.isArray(x.actions) ? x.actions : []).map((a) => String((a as { type?: unknown })?.type ?? ''))
  return graduationCeiling({ actionTypes: t, hasKeywordProtections: pc > 0 }).maxLevel !== 'AUTO'
})
if (capped) {
  const t = (Array.isArray(capped.actions) ? capped.actions : []).map((a) => String((a as { type?: unknown })?.type ?? ''))
  const c = graduationCeiling({ actionTypes: t, hasKeywordProtections: pc > 0 })
  console.log(`\nceiling-refusal subject: "${capped.name}"`)
  console.log(`  id=${capped.id} ceiling=${c.maxLevel} resolved=${resolveAutonomy(capped)} — asking for AUTO must 409 and change nothing`)
}
console.log('\nAdvertisingActionLog rows for set_rule_autonomy in the last 30 min:',
  await prisma.advertisingActionLog.count({ where: { actionType: 'set_rule_autonomy', createdAt: { gte: new Date(Date.now() - 30 * 60_000) } } }))
await prisma.$disconnect()
