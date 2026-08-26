/**
 * PLC page study, pass 3 — READ-ONLY. No writes, no mutations.
 *
 * The 8 "dormant" placement rules have 133,959 AutomationRuleExecution rows and
 * 128,862 of them are FAILED. Nothing anywhere reports that. This measures what
 * is failing, since when, and whether it is still happening.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : 'never')
const H = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`)

console.log('\n═══ PLC pass 3 — the failing placement rules ═══\n')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, executionCount: true, lastExecutedAt: true, actions: true, trigger: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const ACTIONS = ['set_placement_multiplier', 'defend_top_of_search']
const onTab = rules.filter((r) => types(r.actions).some((t) => ACTIONS.includes(t)))
const ids = onTab.map((r) => r.id)
const nameById = new Map(onTab.map((r) => [r.id, r.name]))

H('Per-rule execution outcomes (all time)')
const byRule = await prisma.automationRuleExecution.groupBy({
  by: ['ruleId', 'status'], where: { ruleId: { in: ids } }, _count: { _all: true }, _max: { startedAt: true }, _min: { startedAt: true },
})
const agg = new Map<string, Map<string, { n: number; first: Date | null; last: Date | null }>>()
for (const r of byRule) {
  const m = agg.get(r.ruleId) ?? new Map(); m.set(r.status, { n: r._count._all, first: r._min.startedAt, last: r._max.startedAt }); agg.set(r.ruleId, m)
}
console.log(`${pad('rule', 44)} ${pad('rule.executionCount', 19)} ${pad('status', 9)} ${pad('rows', 9)} ${pad('first', 11)} last`)
for (const r of onTab) {
  const m = agg.get(r.id)
  if (!m) { console.log(`${pad(r.name, 44)} ${pad(int(r.executionCount), 19)} ${pad('(none)', 9)}`); continue }
  for (const [st, v] of m) {
    console.log(`${pad(r.name, 44)} ${pad(int(r.executionCount), 19)} ${pad(st, 9)} ${pad(int(v.n), 9)} ${pad(day(v.first), 11)} ${day(v.last)}`)
  }
}

H('Is it still happening?')
for (const [label, since] of [['last 24h', 1], ['last 7d', 7], ['last 30d', 30], ['all time', 100000]] as Array<[string, number]>) {
  const n = await prisma.automationRuleExecution.count({ where: { ruleId: { in: ids }, status: 'FAILED', startedAt: { gte: new Date(Date.now() - since * 86_400_000) } } })
  console.log(`  FAILED executions ${pad(label, 10)}: ${int(n)}`)
}
const newest = await prisma.automationRuleExecution.findFirst({ where: { ruleId: { in: ids } }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, status: true, ruleId: true } })
console.log(`  most recent execution of ANY placement rule: ${newest?.startedAt.toISOString() ?? 'never'} (${newest?.status ?? '—'}, ${nameById.get(newest?.ruleId ?? '') ?? '—'})`)

H('What is the error?')
const errs = await prisma.automationRuleExecution.groupBy({
  by: ['errorMessage'], where: { ruleId: { in: ids }, status: 'FAILED' }, _count: { _all: true },
})
for (const e of errs.sort((a, b) => b._count._all - a._count._all).slice(0, 12)) {
  console.log(`  ${pad(int(e._count._all), 10)} ${(e.errorMessage ?? '(null errorMessage)').slice(0, 110)}`)
}

H('A sample failed execution — the actionResults')
const sample = await prisma.automationRuleExecution.findFirst({
  where: { ruleId: { in: ids }, status: 'FAILED' }, orderBy: { startedAt: 'desc' },
  select: { ruleId: true, startedAt: true, errorMessage: true, actionResults: true, triggerData: true, durationMs: true },
})
if (sample) {
  console.log(`rule: ${nameById.get(sample.ruleId)}`)
  console.log(`at:   ${sample.startedAt.toISOString()}  durationMs=${sample.durationMs ?? '—'}`)
  console.log(`err:  ${sample.errorMessage ?? '(null)'}`)
  console.log(`actionResults: ${JSON.stringify(sample.actionResults).slice(0, 900)}`)
  console.log(`triggerData:   ${JSON.stringify(sample.triggerData).slice(0, 400)}`)
} else console.log('  no FAILED sample found — verify, this is a real absence or a wrong filter')

H('Account-wide context — is this specific to the placement rules?')
const allStatus = await prisma.automationRuleExecution.groupBy({ by: ['status'], _count: { _all: true } })
console.log(`every advertising+other rule execution, by status: ${allStatus.map((s) => `${s.status}=${int(s._count._all)}`).join(' · ')}`)
const failedAll = await prisma.automationRuleExecution.count({ where: { status: 'FAILED' } })
const failedTab = await prisma.automationRuleExecution.count({ where: { status: 'FAILED', ruleId: { in: ids } } })
console.log(`FAILED account-wide: ${int(failedAll)} · from the 8 placement rules: ${int(failedTab)} (${((failedTab / Math.max(1, failedAll)) * 100).toFixed(0)}%)`)

await prisma.$disconnect()
console.log('\n═══ done — read-only ═══\n')
