import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const recent = await prisma.agentRun.findMany({
  where: { mode: { not: null }, createdAt: { gte: new Date(Date.now() - 864e5) } },
  orderBy: { createdAt: 'desc' },
  select: { agentKey: true, mode: true, trigger: true, costUSD: true, ok: true,
            status: true, createdAt: true, userId: true, findingCount: true },
})
console.log('RUNS IN THE LAST 24H — while every charter is OFF')
for (const r of recent) {
  console.log(`  ${r.createdAt.toISOString().slice(0,16)}  ${r.agentKey.padEnd(24)} mode=${String(r.mode).padEnd(8)} trigger=${String(r.trigger).padEnd(8)} $${Number(r.costUSD).toFixed(4)} ok=${r.ok} findings=${r.findingCount} user=${r.userId ?? 'none'}`)
}
const byTrigger = await prisma.agentRun.groupBy({
  by: ['trigger'], where: { mode: { not: null } },
  _sum: { costUSD: true }, _count: { _all: true },
})
console.log('\nLIFETIME SPEND BY TRIGGER')
for (const t of byTrigger) console.log(`  ${String(t.trigger).padEnd(10)} ${t._count._all} runs  $${Number(t._sum.costUSD ?? 0).toFixed(4)}`)
await prisma.$disconnect()
