/** AUTO.P0 — watch for the FIRST durably-recorded refusal. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.automationRefusalDaily.findMany({ orderBy: { count: 'desc' } })
console.log(`[${new Date().toISOString()}] AutomationRefusalDaily rows: ${rows.length}`)
if (rows.length) {
  const names = new Map((await prisma.automationRule.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.actorId))] } },
    select: { id: true, name: true, maxExecutionsPerDay: true },
  })).map(r => [r.id, r]))
  for (const r of rows) {
    const n = names.get(r.actorId)
    console.log(`   ${(n?.name ?? r.actorId).slice(0,42).padEnd(43)} ${r.dayUtc} ${r.reason.padEnd(20)} cap ${String(n?.maxExecutionsPerDay ?? '—').padStart(4)}  refused ${String(r.count).padStart(6)}`)
  }
  console.log(`\n   verbatim: "${rows[0].lastReason}"`)
  console.log(`   last at : ${rows[0].lastAt.toISOString()}  entity ${rows[0].lastEntityType ?? '—'} ${rows[0].lastEntityId ?? ''}`)
}
await prisma.$disconnect()
