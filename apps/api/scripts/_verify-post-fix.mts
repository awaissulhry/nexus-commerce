import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const FIX = new Date('2026-08-03T00:52:51Z')
const before = await p.adMutation.count({ where: { entityType: 'AD_TARGET', state: 'FAILED', updatedAt: { lt: FIX } } })
const after  = await p.adMutation.count({ where: { entityType: 'AD_TARGET', state: 'FAILED', updatedAt: { gte: FIX } } })
console.log(`AD_TARGET FAILED  before fix: ${before}   after fix: ${after}`)
if (after) {
  const rows = await p.adMutation.findMany({ where: { entityType: 'AD_TARGET', state: 'FAILED', updatedAt: { gte: FIX } }, select: { entityId: true, field: true, lastError: true, updatedAt: true }, take: 5 })
  for (const r of rows) console.log(`  ${r.updatedAt.toISOString()} ${r.field} ${String(r.lastError).slice(0,110)}`)
}
const appliedAfter = await p.adMutation.count({ where: { entityType: 'AD_TARGET', state: 'APPLIED', updatedAt: { gte: FIX } } })
console.log(`AD_TARGET APPLIED after fix: ${appliedAfter}`)
await p.$disconnect()
