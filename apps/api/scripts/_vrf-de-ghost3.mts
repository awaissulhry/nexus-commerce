const { default: prisma } = await import('../src/db.js')
const cs = await prisma.categorySchema.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, productType: true, fetchedAt: true, schemaDefinition: true } })
for (const s of cs) {
  const def = (s.schemaDefinition ?? {}) as { aspects?: Array<{ id?: string; label?: string }> }
  console.log(`\n== mp=${s.marketplace} cat=${s.productType} fetched=${s.fetchedAt?.toISOString?.()}`)
  console.log((def.aspects ?? []).map(a => a.label).join(' | '))
}
await prisma.$disconnect()
