/** BUD page — §1 live check part 2: which rule ratcheted, and why it is quiet now. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const now = Date.now()

for (const id of ['cmpujoff60012rv01crwj5vyt', 'cmps335ls']) {
  const r = await prisma.automationRule.findFirst({
    where: { id: { startsWith: id.slice(0, 12) } },
    select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, maxExecutionsPerDay: true, lastExecutedAt: true, lastEvaluatedAt: true, lastMatchedAt: true },
  })
  console.log(`\n${id} → ${r?.name ?? 'NOT FOUND'}  enabled=${r?.enabled} lvl=${r?.autonomyLevel} trig=${r?.trigger} execs/day=${r?.maxExecutionsPerDay}`)
  console.log(`   lastEval=${r?.lastEvaluatedAt?.toISOString().slice(0, 16)} lastMatch=${r?.lastMatchedAt?.toISOString().slice(0, 16)} lastExec=${r?.lastExecutedAt?.toISOString().slice(0, 16)}`)
}

// executions per day, last 7 days, per budget rule
const all = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, actions: true } })
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((t) => t === 'adjust_ad_budget'))
const ex = await prisma.automationRuleExecution.findMany({
  where: { ruleId: { in: rules.map((r) => r.id) }, startedAt: { gte: new Date(now - 7 * 86_400_000) } },
  select: { ruleId: true, status: true, startedAt: true, errorMessage: true },
})
console.log(`\n── budget-rule executions, last 7 days, by day ──`)
const byDay = new Map<string, Map<string, number>>()
for (const e of ex) {
  const d = e.startedAt.toISOString().slice(0, 10)
  const name = rules.find((r) => r.id === e.ruleId)?.name ?? e.ruleId
  const k = `${name} · ${e.status}`
  if (!byDay.has(d)) byDay.set(d, new Map())
  byDay.get(d)!.set(k, (byDay.get(d)!.get(k) ?? 0) + 1)
}
for (const [d, m] of [...byDay].sort()) {
  console.log(`  ${d}`)
  for (const [k, n] of [...m].sort((a, b) => b[1] - a[1])) console.log(`      ${pad(k, 56)} ${n}`)
}

// what did the 96 SUCCESS executions in the last 24h actually match?
const recent = await prisma.automationRuleExecution.findMany({
  where: { ruleId: { in: rules.map((r) => r.id) }, startedAt: { gte: new Date(now - 86_400_000) }, status: 'SUCCESS' },
  select: { ruleId: true, startedAt: true, triggerData: true, actionResults: true, dryRun: true, errorMessage: true },
  orderBy: { startedAt: 'desc' },
  take: 8,
})
console.log(`\n── the most recent SUCCESS executions: what did they actually do? ──`)
for (const e of recent) {
  console.log(`  ${e.startedAt.toISOString().slice(0, 16)} ${pad(rules.find((r) => r.id === e.ruleId)?.name ?? '', 40)} dryRun=${e.dryRun} err=${e.errorMessage ?? '—'}`)
  console.log(`      trigger : ${JSON.stringify(e.triggerData).slice(0, 260)}`)
  console.log(`      results : ${JSON.stringify(e.actionResults).slice(0, 400)}`)
}

// budget-manager-cron: still writing?
const bmc = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', userId: 'automation:budget-manager-cron' },
  select: { createdAt: true, entityId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true },
  orderBy: { createdAt: 'desc' },
  take: 10,
})
const num = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? x : null }
console.log(`\n── budget-manager-cron, most recent 10 writes ──`)
for (const r of bmc) console.log(`  ${r.createdAt.toISOString().slice(0, 16)} €${String(num(r.payloadBefore) ?? '?').padStart(6)} → €${String(num(r.payloadAfter) ?? '?').padStart(6)} ${r.amazonResponseStatus} camp=${String(r.entityId).slice(0, 12)}`)

// the 24 movable campaigns: what is their current ACOS over 7d? would the AUTO rules match?
const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED', liveBidWritesEnabled: true },
  select: { id: true, name: true, dailyBudget: true, marketplace: true },
})
const movable = camps.filter((c) => Number(c.dailyBudget ?? 0) > 1)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'CAMPAIGN', localEntityId: { in: movable.map((c) => c.id) }, date: { gte: new Date(now - 7 * 86_400_000) } },
  _sum: { costMicros: true, sales7dCents: true },
})
console.log(`\n── the ${movable.length} campaigns still above €1 with the gate open: would a trim rule match? ──`)
console.log(`${pad('campaign', 44)} ${pad('budget', 8)} ${pad('7d spend', 9)} ${pad('7d sales', 9)} ${pad('acos', 7)} matches`)
const rows = movable.map((c) => {
  const p = perf.find((x) => x.localEntityId === c.id)
  const spend = Number(p?._sum.costMicros ?? 0n) / 1e6
  const sales = Number(p?._sum.sales7dCents ?? 0) / 100
  const acos = sales > 0 ? spend / sales : spend > 0 ? Infinity : null
  return { c, spend, sales, acos }
}).sort((a, b) => Number(b.c.dailyBudget ?? 0) - Number(a.c.dailyBudget ?? 0))
for (const r of rows) {
  const m: string[] = []
  if (r.acos != null && r.acos >= 0.4 && r.spend >= 50) m.push('TRIM−15')
  if (r.acos != null && r.acos >= 0.5) m.push('REBAL−20')
  console.log(`${pad(r.c.name, 44)} ${pad(`€${Number(r.c.dailyBudget ?? 0).toFixed(2)}`, 8)} ${pad(`€${r.spend.toFixed(2)}`, 9)} ${pad(`€${r.sales.toFixed(2)}`, 9)} ${pad(r.acos == null ? '—' : r.acos === Infinity ? '∞' : `${(r.acos * 100).toFixed(0)}%`, 7)} ${m.join(' ') || '—'}`)
}
const exposed = rows.filter((r) => r.acos != null && r.acos >= 0.5)
console.log(`\n  🔴 campaigns the −20% rebalance would match RIGHT NOW: ${exposed.length}  (€${exposed.reduce((a, r) => a + Number(r.c.dailyBudget ?? 0), 0).toFixed(2)}/day of budget exposed)`)

await prisma.$disconnect()
