/**
 * RA.AUTO — does `simulateOneRule` do what the route now claims?
 *
 * Deliberately run on rules that are OFF, so nothing here changes what the fleet does. It DOES
 * write AutomationRuleExecution audit rows — that is the documented behaviour and the reason the
 * route reports `wroteAuditRows`. Nothing may reach Amazon.
 *
 * Two subjects, chosen so the guarantee is tested from both sides:
 *   · an alert-only OFF rule — cannot reach Amazon even in principle
 *   · a WRITING OFF rule     — could reach Amazon, and must be stopped by forceDryRun alone
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')
const { simulateOneRule } = await import('../src/jobs/advertising-rule-evaluator.job.js')

const NON_WRITING = new Set(['notify', 'alert_operator', 'log_only'])
const typesOf = (r: { actions: unknown }) =>
  (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: false },
  select: { id: true, name: true, trigger: true, actions: true, enabled: true, dryRun: true, autonomyLevel: true },
})

const alertOnly = rules.find((r) => typesOf(r).every((t) => NON_WRITING.has(t)) && typesOf(r).length > 0)
const writing = rules.find((r) => typesOf(r).some((t) => !NON_WRITING.has(t)))

for (const [label, rule] of [['ALERT-ONLY', alertOnly], ['WRITING', writing]] as const) {
  if (!rule) { console.log(`\n(no ${label} OFF rule found)`); continue }
  console.log(`\n═══ ${label} · "${rule.name}" ═══`)
  console.log(`   trigger=${rule.trigger} enabled=${rule.enabled} resolved=${resolveAutonomy(rule)} actions=${typesOf(rule).join(', ')}`)

  const before = await prisma.automationRuleExecution.count({ where: { ruleId: rule.id } })
  const stillOffBefore = await prisma.automationRule.findUnique({ where: { id: rule.id }, select: { enabled: true, autonomyLevel: true, dryRun: true } })

  const t0 = Date.now()
  const out = await simulateOneRule(rule.id)
  const ms = Date.now() - t0

  const after = await prisma.automationRuleExecution.count({ where: { ruleId: rule.id } })
  const stillOffAfter = await prisma.automationRule.findUnique({ where: { id: rule.id }, select: { enabled: true, autonomyLevel: true, dryRun: true } })

  console.log(`   ok=${out.ok} contextsBuilt=${out.contextsBuilt} inScope=${out.contextsInScope} matched=${out.matched} in ${ms}ms`)
  const statuses = (out.results ?? []).reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m }, {})
  console.log(`   statuses: ${JSON.stringify(statuses)}`)

  // THE assertion that matters: no status may indicate a real apply.
  const applied = (out.results ?? []).filter((r) => r.status === 'SUCCESS' || r.status === 'PARTIAL')
  console.log(`   ${applied.length === 0 ? '✓' : '✗ REACHED AMAZON —'} SUCCESS/PARTIAL rows: ${applied.length} (must be 0)`)

  // The rule must be exactly as it was — `ignoreEnabled` must not have armed it.
  const untouched = JSON.stringify(stillOffBefore) === JSON.stringify(stillOffAfter) && stillOffAfter?.enabled === false
  console.log(`   ${untouched ? '✓' : '✗'} rule still OFF and unmodified: ${JSON.stringify(stillOffAfter)}`)

  console.log(`   audit rows: ${before} → ${after} (+${after - before}, expected +${out.results?.length ?? 0})`)

  const sample = (out.results ?? []).find((r) => r.matched) ?? (out.results ?? [])[0]
  if (sample) console.log(`   sample: status=${sample.status} matched=${sample.matched} actions=${JSON.stringify(sample.actions).slice(0, 320)}`)
}

console.log('\n═══ nothing may have reached Amazon ═══')
// The independent check, from the other side of the write path: an applied ads action leaves an
// AdvertisingActionLog row. A simulation must leave none, and no new PENDING suggestion either.
const since = new Date(Date.now() - 3 * 60_000)
const actionLogs = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since } } })
const outboundQueue = await prisma.outboundSyncQueue.count({ where: { createdAt: { gte: since } } })
const newSuggestions = await prisma.adsRuleSuggestion.count({ where: { createdAt: { gte: since } } })
console.log(`AdvertisingActionLog rows in the last 3 min : ${actionLogs}  (must be 0)`)
console.log(`OutboundSyncQueue rows in the last 3 min    : ${outboundQueue}  (must be 0)`)
console.log(`AdsRuleSuggestion rows in the last 3 min    : ${newSuggestions}  (must be 0 — isTestRun suppresses proposals)`)

await prisma.$disconnect()
