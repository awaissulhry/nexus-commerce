import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const deploy = new Date('2026-08-03T00:52:51Z')
const rows = await p.adMutation.findMany({
  where: { entityType: 'AD_TARGET', updatedAt: { gte: deploy } },
  select: { entityId: true, state: true, attempts: true, lastError: true, updatedAt: true },
  orderBy: { updatedAt: 'desc' },
})
console.log(`AD_TARGET writes since deploy (${deploy.toISOString()}): ${rows.length}`)
const byState = new Map<string, number>()
for (const r of rows) byState.set(r.state, (byState.get(r.state) ?? 0) + 1)
console.log('by state:', JSON.stringify([...byState]))
const ids = [...new Set(rows.map(r => r.entityId))]
if (ids.length) {
  const t = await p.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true } })
  const kindOf = new Map(t.map(x => [x.id, x.kind]))
  const agg = new Map<string, number>()
  for (const r of rows) { const k = `${kindOf.get(r.entityId) ?? '?'}/${r.state}`; agg.set(k, (agg.get(k) ?? 0) + 1) }
  console.log('kind/state:', JSON.stringify([...agg]))
}
// Current dead-letter backlog for the 27
const stuck = await p.adMutation.groupBy({ by: ['state'], where: { entityType: 'AD_TARGET', state: 'FAILED' }, _count: true })
console.log('all-time FAILED AD_TARGET:', JSON.stringify(stuck))
await p.$disconnect()
