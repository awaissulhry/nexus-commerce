import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const num = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? x : null }
const rows = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: new Date('2026-08-05T02:00:00Z'), lt: new Date('2026-08-05T03:00:00Z') } },
  select: { entityId: true, userId: true, payloadBefore: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`rows in that hour: ${rows.length}`)
const byUser = new Map<string, number>()
for (const r of rows) byUser.set(String(r.userId), (byUser.get(String(r.userId)) ?? 0) + 1)
for (const [u, n] of byUser) console.log(`  ${u}  ${n}`)
const ts = new Map<string, number>()
for (const r of rows) { const k = r.createdAt.toISOString().slice(0,19); ts.set(k, (ts.get(k) ?? 0) + 1) }
console.log('by second (top 5):'); for (const [k,n] of [...ts].sort((a,b)=>b[1]-a[1]).slice(0,5)) console.log(`  ${k}  ${n}`)
console.log('sample 8:')
for (const r of rows.slice(0, 8)) console.log(`  ${r.createdAt.toISOString().slice(11,19)} €${num(r.payloadBefore)} → €${num(r.payloadAfter)} ${r.amazonResponseStatus} ${r.userId}`)
await prisma.$disconnect()
