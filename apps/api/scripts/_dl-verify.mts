import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now() - 10 * 60 * 1000)
const rows = await p.adMutation.findMany({
  where: { entityType: 'AD_TARGET', actor: 'automation:dl-requeue' },
  select: { entityId: true, state: true, attempts: true, lastError: true },
})
const t = await p.adTarget.findMany({ where: { id: { in: rows.map(r=>r.entityId) } }, select: { id: true, kind: true, expressionValue: true } })
const k = new Map(t.map(x=>[x.id, `${x.kind} ${x.expressionValue ?? ''}`]))
const tally = new Map<string, number>()
for (const r of rows) tally.set(r.state, (tally.get(r.state) ?? 0) + 1)
console.log('requeued mutation states:', JSON.stringify([...tally]))
for (const r of rows.filter(r => r.state === 'FAILED')) console.log('  FAILED', k.get(r.entityId), '·', String(r.lastError).slice(0,120))
const stillFailing = await p.adMutation.count({ where: { entityType: 'AD_TARGET', state: 'FAILED', updatedAt: { gte: since } } })
console.log('AD_TARGET failures in the last 10 min (any actor):', stillFailing)
await p.$disconnect()
