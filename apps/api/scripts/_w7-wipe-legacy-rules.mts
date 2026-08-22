/**
 * W7 (2026-08-20) — operator instruction, verbatim intent: "remove all the legacy rules that we
 * created with Claude Code and that were not manually created by me."
 *
 * Scope: advertising AutomationRules with createdAt BEFORE the 2026-08-20 legacy cutover — the
 * exact set W1 labelled (all machine-created; provenance measured in `_ra20-rule-provenance.mts`).
 * Rules created today or later (e.g. by AIAD goal materialization) are NOT touched, and neither
 * are the replenishment/reviews domains.
 *
 * What deletion takes with it, and what survives:
 *   · CASCADE: AutomationRuleExecution (evaluation/refusal rows) and CampaignRuleAssignment.
 *   · ALSO deleted here: PENDING AdsRuleSuggestion rows for the wiped rules (no FK — they would
 *     orphan into un-actionable Approve buttons). Applied/dismissed rows stay as history.
 *   · SURVIVES: AdvertisingActionLog — the audit of what these rules actually did to Amazon is
 *     keyed by actor string, not FK.
 *
 * A FULL JSON backup (complete rule rows + assignments + execution aggregates + pending-suggestion
 * summary) is written BEFORE any delete; a rule can be recreated from it verbatim.
 *
 * Default is DRY RUN. Pass --apply to delete.
 */
import '../src/env.js'
import { writeFileSync, mkdirSync } from 'node:fs'
const { default: prisma } = await import('../src/db.js')

const CUTOVER = new Date('2026-08-20T00:00:00.000Z')
const APPLY = process.argv.includes('--apply')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', createdAt: { lt: CUTOVER } },
  orderBy: { createdAt: 'asc' },
})
const ids = rules.map((r) => r.id)

const keep = await prisma.automationRule.count({ where: { domain: 'advertising', createdAt: { gte: CUTOVER } } })
const assignments = await prisma.campaignRuleAssignment.findMany({ where: { ruleId: { in: ids } }, select: { campaignId: true, ruleId: true, kind: true } })
const execAgg = await prisma.automationRuleExecution.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids } }, _count: { _all: true } })
const pendingSug = await prisma.adsRuleSuggestion.groupBy({ by: ['ruleId', 'status'], where: { ruleId: { in: ids } }, _count: { _all: true } })
const pendingCount = pendingSug.filter((s) => s.status === 'pending').reduce((n, s) => n + s._count._all, 0)
const otherSugCount = pendingSug.filter((s) => s.status !== 'pending').reduce((n, s) => n + s._count._all, 0)

const summary = {
  wipedAt: new Date().toISOString(),
  cutover: CUTOVER.toISOString(),
  ruleCount: ids.length,
  keptRulesCreatedTodayOrLater: keep,
  byLevel: rules.reduce<Record<string, number>>((m, r) => { const k = `${r.enabled ? 'enabled' : 'disabled'}:${r.autonomyLevel}`; m[k] = (m[k] ?? 0) + 1; return m }, {}),
  assignments: assignments.length,
  executionRows: execAgg.reduce((n, e) => n + e._count._all, 0),
  pendingSuggestionsToDelete: pendingCount,
  historicalSuggestionsKept: otherSugCount,
}
console.log('SUMMARY', JSON.stringify(summary, null, 1))
for (const r of rules) console.log('RULE', JSON.stringify({ name: r.name, enabled: r.enabled, level: r.autonomyLevel, createdBy: r.createdBy, created: r.createdAt.toISOString().slice(0, 10), execs: r.executionCount }))

// Backup BEFORE any delete, whatever the mode — a dry run's backup is a free rehearsal.
mkdirSync('../../docs/backups', { recursive: true })
const backupPath = `../../docs/backups/2026-08-20-legacy-automation-rules.json`
writeFileSync(backupPath, JSON.stringify({ summary, rules, assignments, executionAggregates: execAgg, suggestionAggregates: pendingSug }, null, 1))
console.log('BACKUP_WRITTEN', backupPath)

if (!APPLY) { console.log('DRY_RUN — nothing deleted. Re-run with --apply.'); await prisma.$disconnect(); process.exit(0) }

const [sugDel, ruleDel] = await prisma.$transaction([
  prisma.adsRuleSuggestion.deleteMany({ where: { ruleId: { in: ids }, status: 'pending' } }),
  prisma.automationRule.deleteMany({ where: { id: { in: ids } } }),
])
const after = await prisma.automationRule.count({ where: { domain: 'advertising' } })
const assignAfter = await prisma.campaignRuleAssignment.count()
console.log('DELETED', JSON.stringify({ pendingSuggestions: sugDel.count, rules: ruleDel.count, advertisingRulesRemaining: after, assignmentRowsRemaining: assignAfter }))
await prisma.$disconnect()
