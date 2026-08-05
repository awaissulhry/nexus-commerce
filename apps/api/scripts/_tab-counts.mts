import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const rules = await p.automationRule.findMany({ where: { domain: 'advertising' }, select: { actions: true, enabled: true } })
const by = new Map<string, { total: number; enabled: number }>()
for (const r of rules) {
  const a = (Array.isArray(r.actions) ? r.actions[0] : null) as { type?: string } | null
  const t = a?.type ?? '(none)'
  const cur = by.get(t) ?? { total: 0, enabled: 0 }
  cur.total++; if (r.enabled) cur.enabled++
  by.set(t, cur)
}
console.log('action type -> rules (enabled):')
for (const [t, v] of [...by].sort((a, b) => b[1].total - a[1].total)) console.log(`  ${t.padEnd(34)} ${v.total} (${v.enabled} enabled)`)
const sched = await p.adSchedule.count({ where: { enabled: true } })
console.log(`\nenabled AdSchedules (dayparting tab): ${sched}`)
await p.$disconnect()
