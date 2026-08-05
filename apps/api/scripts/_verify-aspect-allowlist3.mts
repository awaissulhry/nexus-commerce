/** READ-ONLY: category schema aspect names vs observed junk keys; membership variationSpecifics junk. */
const { default: prisma } = await import('../src/db.js')

const schemas = await prisma.categorySchema.findMany({
  select: { channel: true, marketplace: true, productType: true, schemaDefinition: true, variationThemes: true, fetchedAt: true, isActive: true },
})
console.log('CategorySchema rows:', schemas.length)
for (const s of schemas) {
  const def = (s.schemaDefinition ?? {}) as Record<string, unknown>
  const aspects = (def.aspects ?? def.properties ?? []) as unknown
  let names: string[] = []
  if (Array.isArray(aspects)) names = (aspects as Array<Record<string, unknown>>).map((a) => String(a.name ?? a.localizedAspectName ?? a.id ?? ''))
  else names = Object.keys(aspects as Record<string, unknown>)
  console.log(`\n${s.channel} ${s.marketplace} ${s.productType} active=${s.isActive} n=${names.length}`)
  console.log(JSON.stringify(names))
}

// membership variationSpecifics junk keys
const mem = await prisma.sharedListingMembership.findMany({ select: { sku: true, itemId: true, variationSpecifics: true } })
const vsKeys = new Map<string, number>()
for (const m of mem) {
  const vs = (m.variationSpecifics ?? {}) as Record<string, unknown>
  for (const k of Object.keys(vs)) vsKeys.set(k, (vsKeys.get(k) ?? 0) + 1)
}
console.log('\n--- membership.variationSpecifics keys ---')
for (const [k, c] of [...vsKeys.entries()].sort((a, b) => b[1] - a[1])) console.log(`${JSON.stringify(k)} x${c}`)

// which category do the GALE listings use
const gale = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', product: { sku: { startsWith: 'GALE-JACKET' } } },
  select: { region: true, platformAttributes: true, product: { select: { sku: true } } },
  take: 5,
})
for (const g of gale) {
  const pa = (g.platformAttributes ?? {}) as Record<string, unknown>
  console.log('\nGALE CL', g.product?.sku, g.region, 'categoryId=', pa.categoryId)
}
await prisma.$disconnect()
