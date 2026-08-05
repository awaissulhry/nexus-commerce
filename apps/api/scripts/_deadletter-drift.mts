import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now() - 24 * 3600 * 1000)
const failing = await p.adMutation.findMany({ where: { state: 'FAILED', entityType: 'AD_TARGET', updatedAt: { gte: since } }, select: { entityId: true } })
const ids = [...new Set(failing.map((f) => f.entityId))]
const targets = await p.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, externalTargetId: true } })
const ext = targets.map((t) => t.externalTargetId).filter(Boolean) as string[]

const total = await p.adDrift.count()
console.log(`AdDrift rows total: ${total}`)
const byClass = await p.adDrift.groupBy({ by: ['classification'], _count: true, where: { resolvedAt: null } })
console.log('open drift by classification:', JSON.stringify(byClass))

const hits = await p.adDrift.findMany({
  where: { OR: [{ entityId: { in: ids } }, { entityId: { in: ext } }] },
  select: { entityType: true, entityId: true, entityName: true, classification: true, field: true, ourValue: true, amazonValue: true, lastDetectedAt: true, resolvedAt: true, occurrences: true },
  take: 40,
})
console.log(`\ndrift rows matching the 27 failing targets: ${hits.length}`)
for (const h of hits) console.log(`  ${h.classification.padEnd(16)} ${String(h.field).padEnd(10)} ours=${String(h.ourValue).slice(0,12).padEnd(13)} amazon=${String(h.amazonValue).slice(0,12).padEnd(13)} x${h.occurrences} ${h.resolvedAt ? 'RESOLVED' : 'OPEN'} ${h.lastDetectedAt.toISOString().slice(0,16)}`)
const anyTarget = await p.adDrift.groupBy({ by: ['classification','field'], where: { entityType: 'AD_TARGET' }, _count: true })
console.log('\nALL AD_TARGET drift (any entity):', JSON.stringify(anyTarget))
await p.$disconnect()
