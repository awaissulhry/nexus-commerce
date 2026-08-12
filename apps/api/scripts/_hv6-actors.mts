/**
 * HV.6 — the actor census + the stated-vs-executed measurement. READ-ONLY.
 * Runs the REAL translateConditions / resolveAutonomy / graduationCeiling against the REAL rows.
 */
import '../src/env.js'
const { maybeTranslateAdsRule, isBuilderShapedAdsRule } = await import('../src/services/advertising/ads-rule-adapter.service.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')
const { graduationCeiling } = await import('../src/services/advertising/ads-graduation.js')
const { default: prisma } = await import('../src/db.js')
const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : 'never')

const rules: any[] = await prisma.automationRule.findMany({ orderBy: { createdAt: 'asc' } })
const protCount = await prisma.adKeywordProtection.count()

// ── A · does ANY rule in the account reach translateConditions at all?
console.log(`\n═══ A · builder-shape census over all ${rules.length} rules ═══`)
const shaped = rules.filter((r) => isBuilderShapedAdsRule(r))
const withConds = rules.filter((r) => (Array.isArray(r.conditions) ? r.conditions : []).some((g: any) => (g?.conditions ?? []).length > 0))
console.log(`  builder-shaped (a0.type in BUILDER_SLUGS): ${shaped.length}`)
console.log(`  carrying ANY condition leaf:               ${withConds.length}`)
console.log(`  action-type histogram:`)
const hist = new Map<string, number>()
for (const r of rules) for (const a of (Array.isArray(r.actions) ? r.actions : [])) hist.set(a?.type ?? '?', (hist.get(a?.type ?? '?') ?? 0) + 1)
for (const [k, v] of [...hist].sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(3)} × ${k}`)

// ── B · the harvest actors
const HARVEST_ACTIONS = new Set(['promote_to_exact', 'harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns', 'keyword-harvesting', 'negative-targeting'])
const actors = rules.filter((r) => (Array.isArray(r.actions) ? r.actions : []).some((a: any) => HARVEST_ACTIONS.has(a?.type)))
console.log(`\n═══ B · ${actors.length} rules can create a keyword or a negative ═══`)
console.log(`(keyword protections in account: ${protCount})\n`)
for (const r of actors) {
  const acts: string[] = (Array.isArray(r.actions) ? r.actions : []).map((a: any) => a?.type).filter(Boolean)
  const level = resolveAutonomy(r)
  const ceil = graduationCeiling({ actionTypes: acts, hasKeywordProtections: protCount > 0 })
  const groups: any[] = Array.isArray(r.conditions) ? r.conditions : []
  const stated: string[] = []
  for (const g of groups) for (const c of (g?.conditions ?? [])) stated.push(`${c.metric} ${c.op} ${c.value}`)
  const tr = maybeTranslateAdsRule(r)
  console.log(`── ${r.name}`)
  console.log(`   domain=${r.domain} trigger=${r.trigger} actions=[${acts.join(', ')}]`)
  console.log(`   enabled=${r.enabled} dryRun=${r.dryRun} autonomyLevel=${r.autonomyLevel ?? 'null'}  →  LEVEL=${level}  CEILING=${ceil.maxLevel} blockedBy=[${ceil.blockedBy.join(',')}]`)
  console.log(`   scope: mkt=${r.scopeMarketplace ?? '-'} pf=${r.scopePortfolioId ?? '-'} camp=${r.scopeCampaignId ?? '-'} prod=${r.scopeProductId ?? '-'}`)
  console.log(`   cap=${r.maxExecutionsPerDay ?? 'null'}/day  evals=${r.evaluationCount} matches=${r.matchCount} execs=${r.executionCount}`)
  console.log(`   lastEvaluated=${d(r.lastEvaluatedAt)} lastMatched=${d(r.lastMatchedAt)} lastExecuted=${d(r.lastExecutedAt)}`)
  console.log(`   builder-shaped=${isBuilderShapedAdsRule(r)}  storedConditionLeaves=${stated.length}${stated.length ? `: ${stated.join(' AND ')}` : ''}`)
  console.log(`   translate→ ${tr ? `${tr.conditions.length} leaves: ${tr.conditions.map((c) => `${c.field} ${c.op} ${c.value}`).join(' AND ') || '(none)'}` : 'NULL (adapter never runs; engine uses the stored body)'}`)
  console.log(`   raw conditions: ${JSON.stringify(r.conditions).slice(0, 400)}`)
  console.log(`   raw actions:    ${JSON.stringify(r.actions).slice(0, 500)}\n`)
}
await prisma.$disconnect()
