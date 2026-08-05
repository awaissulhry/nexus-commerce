/** ACR.6 — the 9 AUTO rules can write. Why don't they? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')

const since = new Date(); since.setUTCDate(since.getUTCDate() - 30); since.setUTCHours(0, 0, 0, 0)

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true, conditions: true, actions: true, evaluationCount: true, matchCount: true },
})
const auto = rules.filter((r) => levelActs(resolveAutonomy(r as never)))

console.log(`\n${auto.length} rules resolve to AUTO. What did each actually emit in 30 days?\n`)

for (const r of auto) {
  const execs = await prisma.automationRuleExecution.findMany({
    where: { ruleId: r.id, startedAt: { gte: since } },
    select: { status: true, actionResults: true },
  })
  const byStatus = new Map<string, number>()
  const outputs = new Map<string, number>()
  const errors = new Map<string, number>()
  for (const e of execs) {
    byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1)
    for (const a of (e.actionResults as Array<{ type?: string; ok?: boolean; error?: string; output?: Record<string, unknown> }> | null) ?? []) {
      if (a?.type === 'notify' || a?.type === 'alert_operator') continue
      const k = `${a?.type}:${a?.ok ? 'ok' : 'fail'}`
      outputs.set(k, (outputs.get(k) ?? 0) + 1)
      if (!a?.ok && a?.error) errors.set(a.error.slice(0, 70), (errors.get(a.error.slice(0, 70)) ?? 0) + 1)
      // For the ones that "succeed" but do nothing, show what the output actually said.
      if (a?.ok && a?.output) {
        const zeroish = Object.entries(a.output).filter(([, v]) => v === 0 || (Array.isArray(v) && v.length === 0))
        if (zeroish.length) {
          const k2 = `  └ ok but zero: ${zeroish.map(([kk]) => kk).join(',')}`
          outputs.set(k2, (outputs.get(k2) ?? 0) + 1)
        }
      }
    }
  }
  const trig = String(r.trigger)
  console.log(`── ${r.name}`)
  console.log(`   trigger=${trig}  evaluations(all-time)=${r.evaluationCount}  matches=${r.matchCount}  execs(30d)=${execs.length}`)
  console.log(`   conditions=${JSON.stringify(r.conditions)}`)
  if (byStatus.size) console.log(`   statuses: ${[...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (outputs.size === 0) console.log('   ⚠️  NO non-notify action results at all — the actions never ran')
  for (const [k, v] of [...outputs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`   ${k.startsWith('  ') ? k : `   ${k}`} × ${v}`)
  for (const [k, v] of [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) console.log(`   error: ${k} × ${v}`)
  console.log()
}

await prisma.$disconnect()
