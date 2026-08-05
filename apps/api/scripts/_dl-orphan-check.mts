import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now() - 14 * 24 * 3600 * 1000)
const failed = await p.adMutation.findMany({ where: { state: 'FAILED', entityType: 'AD_TARGET', createdAt: { gte: since } }, select: { entityId: true } })
const ids = [...new Set(failed.map(f => f.entityId))]
const t = await p.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, expressionValue: true, orphanedAt: true, bidCents: true } })
const orph = t.filter(x => x.orphanedAt)
console.log(`${t.length} stranded targets · ${orph.length} flagged orphanedAt`)
const byKind = new Map<string, number>()
for (const x of orph) byKind.set(x.kind, (byKind.get(x.kind) ?? 0) + 1)
console.log('orphaned by kind:', JSON.stringify([...byKind]))
for (const x of orph.slice(0, 20)) console.log(`  ${x.kind.padEnd(8)} ${(x.expressionValue ?? '').padEnd(13)} bid=${x.bidCents} orphanedAt=${x.orphanedAt?.toISOString().slice(0,16)}`)
await p.$disconnect()
