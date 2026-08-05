/** READ-ONLY: what resolveFamilyAxes actually sees for IT-MOSS-JACKET. */
const { default: prisma } = await import('../src/db.js')
const { resolveFamilyAxes } = await import('../src/services/ebay-family-axes.service.js')

const parent = await prisma.product.findFirst({ where: { sku: 'IT-MOSS-JACKET-ALT1', deletedAt: null }, select: { id: true, variationTheme: true } })
console.log('parent theme:', JSON.stringify(parent!.variationTheme))

const cl = await prisma.channelListing.findFirst({
  where: { product: { sku: 'IT-MOSS-JACKET-BLACK-MEN-M' }, channel: 'EBAY', region: 'IT' },
  select: { platformAttributes: true, flatFileSnapshot: true },
})
const pa = (cl?.platformAttributes ?? {}) as Record<string, unknown>
const specs = (pa.itemSpecifics ?? {}) as Record<string, unknown>
console.log('child CL itemSpecifics keys:', JSON.stringify(Object.keys(specs)))
const snap = (cl?.flatFileSnapshot ?? {}) as Record<string, unknown>
console.log('child CL snapshot aspect keys:', JSON.stringify(Object.keys(snap).filter((k) => k.toLowerCase().includes('aspect')).slice(0, 12)))

const res = await resolveFamilyAxes(parent!.id, 'IT')
console.log('resolved axes:', JSON.stringify(res.axes.map((a: { name: string; values: string[] }) => `${a.name}:${a.values.length}v`)))
console.log('warnings:', JSON.stringify(res.warnings))
await prisma.$disconnect()
