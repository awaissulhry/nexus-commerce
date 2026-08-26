/** NEG.X — did the three negations actually land at Amazon? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.adTarget.findMany({
  where: { isNegative: true, expressionValue: 'protezioni' },
  select: { id: true, externalTargetId: true, status: true, orphanedAt: true, createdAt: true,
    adGroup: { select: { name: true, externalAdGroupId: true, campaign: { select: { name: true, marketplace: true } } } } },
  orderBy: { createdAt: 'desc' },
})
console.log(`protezioni negatives: ${rows.length}`)
for (const r of rows) {
  console.log(`  ${r.adGroup?.campaign?.name} › ${r.adGroup?.name}`)
  console.log(`     amazon id: ${r.externalTargetId ?? '🔴 NULL — local only, NOT at Amazon'} · status ${r.status} · orphanedAt ${r.orphanedAt ?? 'null'}`)
}
console.log(`\nwith an Amazon id: ${rows.filter(r=>r.externalTargetId).length} of ${rows.length}`)
await prisma.$disconnect()
