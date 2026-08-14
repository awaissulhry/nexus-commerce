/** CAP — 642 writes to 3 campaigns: what did the budget actually DO? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []
const say = (s = '') => L.push(s)
const eur = (v: unknown) => v == null ? '—' : `€${Number(v).toFixed(2)}`

// 🔴 two rules share the name "Trim budget on weak ACOS" (one AUTO enabled, one PROPOSE).
// Resolve by ACTOR id, never by name — a name lookup would silently pick the wrong row.
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', name: { in: ['Campaign ACOS rebalance (cut + scale)', 'Trim budget on weak ACOS'] } },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, maxExecutionsPerDay: true },
})
say(`rules matching those two names: ${rules.length} — ${rules.map((r) => `${r.name}[${r.autonomyLevel}${r.enabled ? '' : ' DISABLED'}]`).join(' · ')}\n`)

for (const r of rules) {
  const n = await prisma.advertisingActionLog.count({ where: { userId: `automation:${r.id}` } })
  if (n === 0) { say(`■ ${r.name} [${r.autonomyLevel}${r.enabled ? '' : ' DISABLED'}] — 0 writes ever`); continue }
  say(`■ ${r.name} [${r.autonomyLevel}] cap=${r.maxExecutionsPerDay} ROWS/day — ${n} writes ever`)
  const camps = await prisma.$queryRaw<Array<{ entityid: string; n: bigint }>>`
    SELECT "entityId" AS entityid, COUNT(*)::bigint AS n FROM "AdvertisingActionLog"
    WHERE "userId" = ${`automation:${r.id}`} GROUP BY 1 ORDER BY 2 DESC LIMIT 3`
  for (const c of camps) {
    const rows = await prisma.advertisingActionLog.findMany({
      where: { userId: `automation:${r.id}`, entityId: c.entityid },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true },
    })
    const name = (rows[0]?.payloadBefore as { name?: string })?.name ?? c.entityid
    const bud = (p: unknown) => (p as { dailyBudget?: number })?.dailyBudget
    const first = bud(rows[0]?.payloadBefore)
    const last = bud(rows[rows.length - 1]?.payloadAfter)
    const changed = rows.filter((x) => bud(x.payloadBefore) !== bud(x.payloadAfter)).length
    const lo = Math.min(...rows.map((x) => Number(bud(x.payloadAfter) ?? Infinity)).filter(Number.isFinite))
    const hi = Math.max(...rows.map((x) => Number(bud(x.payloadAfter) ?? -Infinity)).filter(Number.isFinite))
    say(`   ${name}`)
    say(`     ${rows.length} writes over ${rows[0].createdAt.toISOString().slice(0, 10)} → ${rows[rows.length - 1].createdAt.toISOString().slice(0, 10)}`)
    say(`     budget ${eur(first)} → ${eur(last)}   range seen ${eur(lo)}…${eur(hi)}   writes that CHANGED the budget: ${changed} of ${rows.length}`)
    say(`     Amazon status: ${[...new Set(rows.map((x) => x.amazonResponseStatus))].join(', ')}`)
    const perDay = new Map<string, number>()
    for (const x of rows) { const d = x.createdAt.toISOString().slice(0, 10); perDay.set(d, (perDay.get(d) ?? 0) + 1) }
    say(`     writes per day: ${[...perDay].map(([d, k]) => `${d.slice(5)}:${k}`).join(' ')}`)
  }
}
process.stdout.write('\n<<<CAP-BUDGETPATH>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
