const { default: prisma } = await import('../src/db.js')
const m = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT marketplace, "parentSku", "itemId", count(*)::int AS n
   FROM "SharedListingMembership" WHERE sku LIKE 'WATERPROOF%' OR "parentSku" LIKE 'WATERPROOF%'
   GROUP BY 1,2,3 ORDER BY 2`,
)
console.log('WATERPROOF MEMBERSHIPS:', JSON.stringify(m))
await prisma.$disconnect()
