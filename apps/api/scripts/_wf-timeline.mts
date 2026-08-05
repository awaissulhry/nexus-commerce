/** READ-ONLY: are the product/auto failures still happening AFTER the DL.1 routing fix deployed? */
const { default: prisma } = await import('../src/db.js')
// 9f87c1e94 committed 2026-08-03 02:47 CEST = 00:47 UTC; deploy lands a few minutes later.
const FIX = new Date('2026-08-03T01:00:00Z')
const rows = await prisma.adMutation.findMany({
  where: { state: 'FAILED', entityType: 'AD_TARGET', updatedAt: { gte: new Date(Date.now() - 7 * 864e5) } },
  select: { entityId: true, updatedAt: true, createdAt: true, attempts: true },
  orderBy: { updatedAt: 'desc' },
})
const after = rows.filter((r) => r.updatedAt >= FIX)
console.log(`AD_TARGET failures in 7d: ${rows.length}`)
console.log(`  BEFORE the DL.1 fix (< 2026-08-03 01:00Z): ${rows.length - after.length}`)
console.log(`  AFTER  the DL.1 fix:                       ${after.length}`)
console.log(`  most recent failure: ${rows[0]?.updatedAt.toISOString()}`)
console.log(`  (now: ${new Date().toISOString()})\n`)
// Did any product/auto target SUCCEED since the fix?
const ok = await prisma.adMutation.findMany({ where: { state: 'APPLIED', entityType: 'AD_TARGET', updatedAt: { gte: FIX } }, select: { entityId: true, updatedAt: true } })
const ids = [...new Set(ok.map((r) => r.entityId))]
const kinds = ids.length ? await prisma.adTarget.groupBy({ by: ['kind'], where: { id: { in: ids } }, _count: { _all: true } }) : []
console.log(`AD_TARGET mutations APPLIED since the fix: ${ok.length} across ${ids.length} targets`)
console.log(`  by kind: ${kinds.map((k) => `${k.kind}=${k._count._all}`).join(' ') || '(none)'}`)
// And the entity-level truth: lastSyncStatus per kind.
const st = await prisma.adTarget.groupBy({ by: ['kind', 'lastSyncStatus'], _count: { _all: true } })
console.log('\nAdTarget.lastSyncStatus by kind (entity truth):')
for (const r of st.sort((a, b) => a.kind.localeCompare(b.kind))) console.log(`  ${r.kind.padEnd(9)} ${String(r.lastSyncStatus ?? 'never').padEnd(8)} ${r._count._all}`)
await prisma.$disconnect()
