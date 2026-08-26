/**
 * AUTO page study — does the daily cap still bite? READ-ONLY.
 *
 * The cap stopped writing DAILY_CAP_EXCEEDED rows on 2026-08-04, so "how often was a rule
 * refused" is no longer answerable from the execution table. It is still answerable indirectly:
 * a rule that reached its cap on a day has EXACTLY `maxExecutionsPerDay` non-refusal rows for
 * that day and no more. This counts that.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const DAY = 86_400_000

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, autonomyLevel: true, enabled: true, maxExecutionsPerDay: true },
})
const byId = new Map(rules.map((r) => [r.id, r]))

// 8 full days back, excluding today (which is partial).
const from = new Date(Date.now() - 8 * DAY); from.setUTCHours(0, 0, 0, 0)
const to = new Date(); to.setUTCHours(0, 0, 0, 0)
const execs = await prisma.automationRuleExecution.findMany({
  // The null branch MUST be spelled out. `NOT: { errorMessage: 'X' }` compiles to
  // NOT (errorMessage = 'X'), which is NULL — not TRUE — for the null errorMessage every
  // SUCCESS and DRY_RUN row carries. The terse form silently returns ZERO rows, which reads
  // exactly like "the evaluator has stopped". It did that to this script on its first run.
  where: {
    startedAt: { gte: from, lt: to },
    OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }],
  },
  select: { ruleId: true, startedAt: true, status: true },
})
console.log(`\n═══ Executions per rule per UTC day, ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)} ═══\n`)
const perRuleDay = new Map<string, Map<string, number>>()
for (const e of execs) {
  const d = e.startedAt.toISOString().slice(0, 10)
  const m = perRuleDay.get(e.ruleId) ?? new Map<string, number>()
  m.set(d, (m.get(d) ?? 0) + 1)
  perRuleDay.set(e.ruleId, m)
}
console.log(`${pad('rule', 46)} ${pad('cap', 5)} ${pad('max/day', 8)} days at cap`)
let anyAtCap = 0
for (const [ruleId, days] of [...perRuleDay.entries()].sort((a, b) => Math.max(...b[1].values()) - Math.max(...a[1].values()))) {
  const r = byId.get(ruleId)
  if (!r) continue
  const max = Math.max(...days.values())
  const cap = r.maxExecutionsPerDay
  const atCap = cap != null ? [...days.values()].filter((n) => n >= cap).length : 0
  if (atCap > 0) anyAtCap++
  console.log(`   ${pad(r.name, 46)} ${pad(String(cap ?? '∞'), 5)} ${pad(String(max), 8)} ${atCap > 0 ? `🔴 ${atCap} of ${days.size}` : `— (0 of ${days.size})`}`)
}
console.log(`\n${anyAtCap} rules hit their cap on at least one of the last 8 full days.`)
console.log(`total non-refusal executions in the window: ${execs.length.toLocaleString('en-IE')}`)

// And the evidence field — measured properly this time, by reading rows rather than filtering on
// a Json column (a `{ not: undefined }` filter is NO filter and returns the whole table).
const sample = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: new Date(Date.now() - 7 * DAY) } },
  select: { evidence: true, actionType: true, userId: true },
  take: 4000,
})
const withEvidence = sample.filter((s) => s.evidence != null)
console.log(`\n═══ Structured evidence on the audit row ═══`)
console.log(`sampled ${sample.length} rows from the last 7 days · ${withEvidence.length} carry an \`evidence\` object (${((withEvidence.length / Math.max(1, sample.length)) * 100).toFixed(1)}%)`)
const byKind = new Map<string, { n: number; withEv: number }>()
for (const s of sample) {
  const e = byKind.get(s.actionType) ?? { n: 0, withEv: 0 }
  e.n++; if (s.evidence != null) e.withEv++
  byKind.set(s.actionType, e)
}
for (const [k, v] of [...byKind].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
  console.log(`   ${pad(k, 30)} ${String(v.n).padStart(5)} rows · ${String(v.withEv).padStart(5)} with evidence`)
}
if (withEvidence[0]) console.log(`   example evidence: ${JSON.stringify(withEvidence[0].evidence).slice(0, 220)}`)

await prisma.$disconnect()
