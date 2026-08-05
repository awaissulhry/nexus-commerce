/** READ-ONLY: value-order determinism probe — resolver twice + stored state. */
const { default: prisma } = await import('../src/db.js')
const { resolveFamilyAxes } = await import('../src/services/ebay-family-axes.service.js')

for (const sku of ['IT-MOSS-JACKET', 'AIREON']) {
  const parent = await prisma.product.findFirst({ where: { sku, deletedAt: null }, select: { id: true } })
  if (!parent) { console.log(sku, '(absent)'); continue }
  const a = await resolveFamilyAxes(parent.id, 'IT')
  const b = await resolveFamilyAxes(parent.id, 'IT')
  const sig = (r: typeof a) => JSON.stringify(r.axes.map((x: { name: string; values: string[] }) => `${x.name}=[${x.values.join(',')}]`))
  console.log(sku, '→ stable:', sig(a) === sig(b))
  console.log('  axes:', sig(a).slice(0, 220))
  const cl = await prisma.channelListing.findFirst({
    where: { productId: parent.id, channel: 'EBAY', marketplace: 'IT' },
    select: { platformAttributes: true },
  })
  const pa = (cl?.platformAttributes ?? {}) as Record<string, unknown>
  console.log('  stored order keys:', JSON.stringify({
    _axisSortOrder: pa._axisSortOrder ?? '(none)',
    _variationAxes: pa._variationAxes ?? '(none)',
  }).slice(0, 300))
}
await prisma.$disconnect()
