// READ-ONLY. No writes.
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.categorySchema.findMany({
  where: { channel: 'EBAY' },
  select: { marketplace: true, productType: true, schemaVersion: true, schemaDefinition: true, fetchedAt: true },
})
for (const r of rows) {
  const j = (r.schemaDefinition ?? {}) as Record<string, unknown>
  const aspects = (j.aspects ?? []) as Array<{ id?: string; label?: string }>
  console.log(`\n=== ${r.marketplace} cat=${r.productType} v=${r.schemaVersion} updated=${r.fetchedAt?.toISOString()} aspects=${aspects.length}`)
  console.log('   ids:', aspects.slice(0, 40).map((a) => a.id).join(' | '))
}
await prisma.$disconnect()
