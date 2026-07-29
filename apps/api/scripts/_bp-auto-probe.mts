// READ-ONLY. Can we recover WHICH auto-targeting clause a synced AUTO target is?
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

const rows = await prisma.adTarget.groupBy({
  by: ['kind', 'expressionType', 'expressionValue'],
  _count: { _all: true },
  where: { kind: { in: ['AUTO', 'PRODUCT_CATEGORY', 'PRODUCT_AUDIENCE', 'PRODUCT_CATEGORY_AUDIENCE', 'AUDIENCE'] }, orphanedAt: null },
})
L('non-KEYWORD/PRODUCT targets — kind · expressionType · expressionValue:')
for (const r of rows.sort((a, b) => b._count._all - a._count._all)) {
  L(`  ${String(r.kind).padEnd(28)} type=${String(r.expressionType).padEnd(24)} value=${JSON.stringify(r.expressionValue).padEnd(10)} ×${r._count._all}`)
}

// Do the AIREON Auto campaign's targets carry anything usable?
const air = await prisma.adTarget.findMany({
  where: { adGroup: { campaign: { name: 'IT-AIREON-SP-Auto' } } },
  select: { kind: true, expressionType: true, expressionValue: true, bidCents: true, status: true, externalTargetId: true },
})
L(`\nIT-AIREON-SP-Auto targets: ${air.length}`)
for (const t of air.slice(0, 12)) L(`  kind=${t.kind} type=${t.expressionType} value=${JSON.stringify(t.expressionValue)} bid=${t.bidCents}c ${t.status} ext=${t.externalTargetId ?? '-'}`)

await prisma.$disconnect()
