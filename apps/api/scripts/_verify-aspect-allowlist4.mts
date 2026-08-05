/** READ-ONLY: membership variationSpecifics key census + GALE category ids. */
const { default: prisma } = await import('../src/db.js')
const mem = await prisma.sharedListingMembership.findMany({ select: { sku: true, itemId: true, variationSpecifics: true } })
const vsKeys = new Map<string, number>()
for (const m of mem) {
  const vs = (m.variationSpecifics ?? {}) as Record<string, unknown>
  for (const k of Object.keys(vs)) vsKeys.set(k, (vsKeys.get(k) ?? 0) + 1)
}
console.log('MEMBERSHIP variationSpecifics keys:')
for (const [k, c] of [...vsKeys.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${JSON.stringify(k)} x${c}`)

const gale = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', product: { sku: { in: ['IT-GALE-JACKET', 'GALE-JACKET', 'GALE-JACKET-ALT1', 'GALE-JACKET-BLACK-MEN-XXS'] } } },
  select: { region: true, platformAttributes: true, product: { select: { sku: true } } },
})
for (const g of gale) {
  const pa = (g.platformAttributes ?? {}) as Record<string, unknown>
  console.log('GALE CL', g.product?.sku, g.region, 'categoryId=', pa.categoryId)
}
await prisma.$disconnect()
