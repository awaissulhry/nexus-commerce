/**
 * RA.3 — the Automations-page inventory census. READ-ONLY: no writes, no mutations.
 *
 * Answers the questions the 4.2 study has to answer before a section list is honest:
 *   1. the 51, by resolved autonomy level and by category
 *   2. how many land in each proposed Type-filter bucket — including the ones with no type home
 *   3. how many have EVER executed, and which AUTO rules have written anything in 30 days
 *   4. how many rows the console currently MISLABELS: dryRun disagreeing with autonomyLevel
 *   5. how much of a rule row the five rule-type tabs can actually render (criteria / frequency)
 *   6. the pending-suggestion queue, and its age
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy, levelActs, levelProposes } = await import('../src/services/advertising/ads-autonomy.js')
const { ruleCategory, RULE_CATEGORY_META } = await import('../src/services/advertising/rule-category.js')

// The CLIENT's tab map, copied verbatim from web _shared/tabs.tsx so the two can be compared.
const RULE_TAB_ACTION_TYPES: Record<string, string[]> = {
  bid: ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense'],
  budget: ['adjust_ad_budget'],
  placement: ['set_placement_multiplier', 'defend_top_of_search'],
  'keyword-harvest': ['promote_to_exact', 'harvest_and_negate'],
  'negative-targeting': ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns'],
}
const TAB_MAPPED = new Set(Object.values(RULE_TAB_ACTION_TYPES).flat())

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, trigger: true, enabled: true, dryRun: true, autonomyLevel: true,
    actions: true, conditions: true, executionCount: true, matchCount: true, evaluationCount: true,
    lastExecutedAt: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true,
    maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true, createdAt: true,
  },
  orderBy: { name: 'asc' },
})
const typesOf = (r: { actions: unknown }) =>
  (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)

console.log(`\n═══ 1 · THE CENSUS — ${rules.length} advertising rules ═══`)
const byLevel: Record<string, number> = {}
for (const r of rules) { const l = resolveAutonomy(r); byLevel[l] = (byLevel[l] ?? 0) + 1 }
console.log('resolved level :', JSON.stringify(byLevel))
console.log('acts (AUTO)    :', rules.filter((r) => levelActs(resolveAutonomy(r))).length)
console.log('proposes       :', rules.filter((r) => levelProposes(resolveAutonomy(r))).length)
console.log('stored autonomyLevel column:', JSON.stringify(
  rules.reduce<Record<string, number>>((m, r) => { const k = String(r.autonomyLevel ?? 'NULL'); m[k] = (m[k] ?? 0) + 1; return m }, {})))
console.log('scope          : account=%d portfolio=%d campaign=%d · scopeMarketplace set=%d',
  rules.filter((r) => !r.scopePortfolioId && !r.scopeCampaignId).length,
  rules.filter((r) => r.scopePortfolioId).length,
  rules.filter((r) => r.scopeCampaignId).length,
  rules.filter((r) => r.scopeMarketplace).length)

console.log(`\n═══ 2 · TYPE HOMES ═══`)
const catCount: Record<string, number> = {}
for (const r of rules) { const c = ruleCategory(typesOf(r)); catCount[c] = (catCount[c] ?? 0) + 1 }
console.log('server rule-category.ts (8 families):')
for (const [c, n] of Object.entries(catCount).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(c).padEnd(10)} ${String(n).padStart(3)}  ${RULE_CATEGORY_META[c as keyof typeof RULE_CATEGORY_META].label}`)
}
const tabHits: Record<string, number> = {}
let noTabHome = 0
const homeless: Array<{ name: string; level: string; cat: string; types: string[] }> = []
for (const r of rules) {
  const t = typesOf(r)
  let any = false
  for (const [tab, want] of Object.entries(RULE_TAB_ACTION_TYPES)) {
    if (t.some((x) => want.includes(x))) { tabHits[tab] = (tabHits[tab] ?? 0) + 1; any = true }
  }
  if (!any) { noTabHome++; homeless.push({ name: r.name, level: resolveAutonomy(r), cat: ruleCategory(t), types: [...new Set(t)] }) }
}
console.log('\nclient RULE_TAB_ACTION_TYPES (5 tabs):', JSON.stringify(tabHits))
console.log(`rules with NO tab home: ${noTabHome} of ${rules.length}`)
for (const h of homeless) console.log(`   [${h.level.padEnd(7)}] ${h.cat.padEnd(9)} ${h.name}  ←  ${h.types.join(', ')}`)

const allTypes = [...new Set(rules.flatMap(typesOf))].sort()
const unmappedTypes = allTypes.filter((t) => !TAB_MAPPED.has(t))
console.log(`\ndistinct action types in use: ${allTypes.length} · mapped by the tabs: ${TAB_MAPPED.size} · in use but UNMAPPED: ${unmappedTypes.length}`)
console.log('   unmapped:', unmappedTypes.join(', '))

console.log(`\n═══ 3 · WHAT HAS ACTUALLY RUN ═══`)
console.log('lifetime executionCount > 0 :', rules.filter((r) => r.executionCount > 0).length, 'of', rules.length)
console.log('lastExecutedAt ever set     :', rules.filter((r) => r.lastExecutedAt).length)
console.log('matchCount > 0              :', rules.filter((r) => r.matchCount > 0).length)
console.log('evaluationCount === 0       :', rules.filter((r) => r.evaluationCount === 0).length, '(never even evaluated)')

const thirty = new Date(Date.now() - 30 * 86_400_000)
const autoRules = rules.filter((r) => levelActs(resolveAutonomy(r)))
console.log(`\nthe ${autoRules.length} AUTO rules, over 30 days — real writes only (DAILY_CAP_EXCEEDED excluded):`)
for (const r of autoRules) {
  const g = await prisma.automationRuleExecution.groupBy({
    by: ['status'],
    where: { ruleId: r.id, startedAt: { gte: thirty }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] },
    _count: { _all: true },
  })
  const m = Object.fromEntries(g.map((x) => [x.status, x._count._all]))
  const capped = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: thirty }, errorMessage: 'DAILY_CAP_EXCEEDED' } })
  const wrote = (m.SUCCESS ?? 0) + (m.PARTIAL ?? 0)
  console.log(`   ${wrote > 0 ? '✍ ' : '  '}${r.name.slice(0, 52).padEnd(54)} success=${String(m.SUCCESS ?? 0).padStart(4)} partial=${String(m.PARTIAL ?? 0).padStart(3)} dry=${String(m.DRY_RUN ?? 0).padStart(4)} failed=${String(m.FAILED ?? 0).padStart(4)} nomatch=${String(m.NO_MATCH ?? 0).padStart(5)} | capped=${capped}`)
}
console.log(`AUTO rules that wrote something in 30d: ${(await Promise.all(autoRules.map(async (r) => await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: thirty }, status: { in: ['SUCCESS', 'PARTIAL'] } } }) > 0))).filter(Boolean).length} of ${autoRules.length}`)

console.log(`\n═══ 4 · HOW MANY ROWS THE CONSOLE MISLABELS ═══`)
// ads-console/automation derives its Live / Dry-run / Off chips from `enabled && !dryRun`.
// resolveAutonomy() ignores dryRun whenever autonomyLevel is set. Where they disagree, the chip lies.
let disagree = 0
const rows: string[] = []
for (const r of rules) {
  const real = resolveAutonomy(r)
  const consoleSays = !r.enabled ? 'Off' : r.dryRun ? 'Dry-run' : 'LIVE'
  const truth = real === 'OFF' ? 'Off' : real === 'AUTO' ? 'LIVE' : real === 'PROPOSE' ? 'Dry-run' : 'Observe'
  if (consoleSays !== truth) { disagree++; rows.push(`   console="${consoleSays}" truth=${real} (enabled=${r.enabled} dryRun=${r.dryRun} level=${r.autonomyLevel}) ${r.name}`) }
}
console.log(`rules where the console's chip disagrees with resolveAutonomy(): ${disagree} of ${rules.length}`)
for (const s of rows) console.log(s)
console.log(`console "live" count (enabled && !dryRun): ${rules.filter((r) => r.enabled && !r.dryRun).length}   ·   truth (AUTO): ${autoRules.length}`)

console.log(`\n═══ 5 · WHAT THE FIVE RULE-TYPE TABS CAN RENDER ═══`)
// RuleListTab.ruleToRow reads actions[0].control and actions[0].schedule.{frequency,time};
// summariseRule reads conditions[0].conditions[] and conditions[0].action — a BUILDER shape.
let hasSchedule = 0, hasControl = 0, hasNestedConds = 0, hasNestedAction = 0
for (const r of rules) {
  const a0 = (Array.isArray(r.actions) ? r.actions[0] : null) as { control?: unknown; schedule?: unknown } | null
  if (a0 && a0.schedule && typeof a0.schedule === 'object') hasSchedule++
  if (a0 && a0.control != null) hasControl++
  const c0 = (Array.isArray(r.conditions) ? r.conditions[0] : null) as { conditions?: unknown; action?: unknown } | null
  if (c0 && Array.isArray(c0.conditions)) hasNestedConds++
  if (c0 && c0.action != null) hasNestedAction++
}
console.log(`actions[0].schedule present : ${hasSchedule} of ${rules.length}  → the rest render the hard-coded "Daily · 12:00 AM"`)
console.log(`actions[0].control present  : ${hasControl} of ${rules.length}  → the rest render the Automation switch OFF regardless of level`)
console.log(`conditions[0].conditions[]  : ${hasNestedConds} of ${rules.length}  → the rest render Criteria as "—"`)
console.log(`conditions[0].action        : ${hasNestedAction} of ${rules.length}`)

console.log(`\n═══ 6 · THE PENDING QUEUE ═══`)
const sugg = await prisma.adsRuleSuggestion.groupBy({ by: ['status'], _count: { _all: true } })
console.log('AdsRuleSuggestion by status:', JSON.stringify(Object.fromEntries(sugg.map((s) => [s.status, s._count._all]))))
const oldest = await prisma.adsRuleSuggestion.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
const newest = await prisma.adsRuleSuggestion.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
const age = (d?: Date | null) => (d ? `${Math.floor((Date.now() - d.getTime()) / 86_400_000)}d old` : '—')
console.log(`oldest pending: ${age(oldest?.createdAt)} · newest pending: ${age(newest?.createdAt)}`)
const byRule = await prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { status: 'PENDING' }, _count: { _all: true }, orderBy: { _count: { ruleId: 'desc' } }, take: 8 })
for (const b of byRule) {
  const nm = b.ruleId ? (await prisma.automationRule.findUnique({ where: { id: b.ruleId }, select: { name: true, autonomyLevel: true, enabled: true } })) : null
  console.log(`   ${String(b._count._all).padStart(4)} pending ← ${nm?.name ?? `(ruleId ${b.ruleId ?? 'null'})`} [${nm ? resolveAutonomy(nm as never) : '?'}]`)
}
console.log('\n(read-only — nothing was written)')
await prisma.$disconnect()
