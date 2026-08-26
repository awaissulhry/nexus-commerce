/** BUD part 3 — the 2,386 AD_BUDGET_UPDATE rows, with the CORRECT field names. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const since = new Date(Date.now() - 60 * 86_400_000)
const rows = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since }, actionType: 'AD_BUDGET_UPDATE' },
  select: { executionId: true, userId: true, entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true, rolledBackAt: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`\nAD_BUDGET_UPDATE rows, 60d: ${rows.length}`)
console.log(`  from a rule execution : ${rows.filter((r) => r.executionId).length}`)
console.log(`  from a user/other     : ${rows.filter((r) => !r.executionId).length}`)
const byActor = new Map<string, number>()
for (const r of rows) byActor.set(String(r.userId ?? '(no userId)'), (byActor.get(String(r.userId ?? '(no userId)')) ?? 0) + 1)
console.log('  by userId:')
for (const [a, n] of [...byActor].sort((x, y) => y[1] - x[1]).slice(0, 10)) console.log(`    ${pad(a, 52)} ${n}`)
const byStatus = new Map<string, number>()
for (const r of rows) byStatus.set(String(r.amazonResponseStatus ?? '—'), (byStatus.get(String(r.amazonResponseStatus ?? '—')) ?? 0) + 1)
console.log(`  amazonResponseStatus: ${[...byStatus].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log(`  rolled back: ${rows.filter((r) => r.rolledBackAt).length}`)

const num = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? x : null }
const moves = rows.map((r) => ({ b: num(r.payloadBefore), a: num(r.payloadAfter), at: r.createdAt, id: r.entityId }))
  .filter((m) => m.b != null && m.a != null) as Array<{ b: number; a: number; at: Date; id: string }>
console.log(`\n  rows with a readable before→after: ${moves.length}`)
const up = moves.filter((m) => m.a > m.b), down = moves.filter((m) => m.a < m.b), same = moves.filter((m) => m.a === m.b)
console.log(`    increases: ${up.length}  ·  decreases: ${down.length}  ·  NO CHANGE: ${same.length}`)
if (same.length) console.log(`    ← a "no change" write is the €1 floor absorbing the trim`)
console.log('  most recent 12:')
for (const m of moves.slice(0, 12)) console.log(`    ${m.at.toISOString().slice(0, 16)}  €${m.b.toFixed(2).padStart(7)} → €${m.a.toFixed(2).padStart(7)}  ${m.a === m.b ? '(no change)' : ''}`)
const uniq = new Set(rows.map((r) => r.entityId))
console.log(`\n  distinct campaigns touched: ${uniq.size}`)
await prisma.$disconnect()
