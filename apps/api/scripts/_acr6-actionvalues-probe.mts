/** ACR.6 — are the impact strip's zeros a bug, or the truth? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const since = new Date(); since.setUTCDate(since.getUTCDate() - 30); since.setUTCHours(0, 0, 0, 0)

const execs = await prisma.automationRuleExecution.findMany({
  where: { startedAt: { gte: since }, status: { in: ['SUCCESS', 'PARTIAL'] }, rule: { domain: 'advertising' } },
  select: { actionResults: true, dryRun: true, status: true, rule: { select: { name: true } } },
})

let applied = 0, paused = 0, skipped = 0, budgets = 0
const bidUpErrors = new Map<string, number>()
const perRule = new Map<string, { runs: number; applied: number; paused: number; budgets: number; bidUpFail: number }>()

for (const e of execs) {
  const name = e.rule?.name ?? '(unknown)'
  if (!perRule.has(name)) perRule.set(name, { runs: 0, applied: 0, paused: 0, budgets: 0, bidUpFail: 0 })
  const pr = perRule.get(name)!
  pr.runs++
  for (const a of (e.actionResults as Array<{ type?: string; ok?: boolean; error?: string; output?: Record<string, unknown> }> | null) ?? []) {
    const o = a?.output ?? {}
    if (a?.type === 'bid_to_target_acos') { applied += Number(o.applied ?? 0); pr.applied += Number(o.applied ?? 0) }
    if (a?.type === 'retail_guard') { paused += Number(o.paused ?? 0); skipped += Number(o.skipped ?? 0); pr.paused += Number(o.paused ?? 0) }
    if (a?.type === 'adjust_ad_budget') { budgets += 1; pr.budgets += 1 }
    if (a?.type === 'bid_up' && !a?.ok) {
      pr.bidUpFail++
      const key = (a?.error ?? '(no error field)').slice(0, 90)
      bidUpErrors.set(key, (bidUpErrors.get(key) ?? 0) + 1)
    }
  }
}

console.log(`\nSUMS over ${execs.length} advertising executions, 30d:`)
console.log(`  bid_to_target_acos → applied .... ${applied}`)
console.log(`  retail_guard       → paused ..... ${paused}   (skipped ${skipped})`)
console.log(`  adjust_ad_budget   → results .... ${budgets}`)
console.log(`  harvest_and_negate → results .... 0  (this action type never appears)`)

console.log('\nbid_up failures — what do they say?')
for (const [k, n] of [...bidUpErrors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${String(n).padStart(5)}  ${k}`)

console.log('\nper rule (top 8 by runs):')
for (const [n, v] of [...perRule.entries()].sort((a, b) => b[1].runs - a[1].runs).slice(0, 8)) {
  console.log(`  ${n.slice(0, 42).padEnd(44)} runs=${String(v.runs).padStart(5)} applied=${String(v.applied).padStart(4)} paused=${String(v.paused).padStart(3)} budgets=${String(v.budgets).padStart(3)} bidUpFail=${String(v.bidUpFail).padStart(5)}`)
}

await prisma.$disconnect()
