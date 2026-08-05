/** ACR.6 — was the "one-way ratchet" claim actually true? Did bid_down on ad_group EVER fire? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, dryRun: true, trigger: true, actions: true },
})

const bidRules = rules.filter((r) => {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  return acts.some((a) => a?.type === 'bid_up' || a?.type === 'bid_down')
})

console.log('\nrule                                       trigger                        action    target      enabled dry   execs(all-time)  bid results seen')
for (const r of bidRules) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const a = acts.find((x) => x?.type === 'bid_up' || x?.type === 'bid_down')!
  const execs = await prisma.automationRuleExecution.count({ where: { ruleId: r.id } })
  const rows = await prisma.automationRuleExecution.findMany({
    where: { ruleId: r.id, status: { in: ['SUCCESS', 'PARTIAL'] } },
    select: { actionResults: true }, take: 500, orderBy: { startedAt: 'desc' },
  })
  let seen = 0, ok = 0
  for (const e of rows) {
    for (const ar of (e.actionResults as Array<{ type?: string; ok?: boolean }> | null) ?? []) {
      if (ar?.type === a.type) { seen++; if (ar.ok) ok++ }
    }
  }
  console.log(
    `${r.name.slice(0, 40).padEnd(42)} ${String(r.trigger).padEnd(30)} ${String(a.type).padEnd(9)} ${String(a.target ?? 'ad_target*').padEnd(11)} ${String(r.enabled).padEnd(7)} ${String(r.dryRun).padEnd(5)} ${String(execs).padStart(7)}          ${seen} seen / ${ok} ok`,
  )
}

console.log('\n(* = target omitted, handler defaults to ad_target)')
console.log('"bid results seen" scans the last 500 SUCCESS|PARTIAL executions of that rule.')

await prisma.$disconnect()
