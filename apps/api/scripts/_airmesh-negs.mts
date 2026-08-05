/** READ-ONLY: which AIRMESH negatives never reached Amazon, and why they might not have. */
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.adTarget.findMany({
  where: {
    isNegative: true, externalTargetId: null,
    adGroup: { campaign: { marketplace: 'IT', name: { startsWith: 'IT-AIRMESH-' } } },
  },
  select: { id: true, expressionValue: true, expressionType: true, kind: true,
    adGroup: { select: { name: true } } },
})
console.log(`negatives with no Amazon id: ${rows.length}`)
for (const r of rows) console.log(`  [${r.kind}/${r.expressionType}] "${r.expressionValue}"  in ${r.adGroup?.name}`)
await prisma.$disconnect()
