const { default: prisma } = await import('../src/db.js')

const byType = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "eventType", "aggregateType", COUNT(*)::int AS n, MAX("createdAt") AS last
  FROM "ProductEvent"
  GROUP BY 1,2 ORDER BY n DESC LIMIT 40
`)
console.log('=== ProductEvent by type ===')
for (const r of byType) console.log(r.eventType.padEnd(28), r.aggregateType.padEnd(16), String(r.n).padStart(8), r.last?.toISOString?.() ?? '')

// GALE duplicates: when were the duplicate Products created, and did any event exist?
const gale = await prisma.product.findMany({
  where: { sku: { contains: 'GALE' } },
  select: { id: true, sku: true, parentId: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
  take: 60,
})
console.log('\n=== GALE products ===')
for (const p of gale) console.log(p.sku.padEnd(34), p.parentId ? 'child' : 'MASTER', p.createdAt.toISOString(), p.id)

const ids = gale.map((g) => g.id)
const ev = await prisma.productEvent.findMany({
  where: { aggregateId: { in: ids }, eventType: { in: ['PRODUCT_CREATED', 'PRODUCT_DELETED'] } },
  select: { aggregateId: true, eventType: true, createdAt: true },
  take: 20,
})
console.log('\nPRODUCT_CREATED/DELETED events for GALE products:', ev.length)

await prisma.$disconnect()
