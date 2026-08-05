// READ-ONLY verification probe. No writes.
const { default: prisma } = await import('../src/db.js')

const skus = ['WATERPROOF-OVERJACKET-BLACK-MEN-M', 'WATERPROOF-OVERJACKET-BLACK-MEN', 'GALE-JACKET-BLACK-MEN-3XL']
for (const sku of skus) {
  const p = await prisma.product.findFirst({
    where: { sku },
    select: { id: true, sku: true, categoryAttributes: true },
  })
  if (!p) { console.log('MISSING', sku); continue }
  const ca = (p.categoryAttributes ?? {}) as Record<string, unknown>
  console.log('=== PRODUCT', p.sku, )
  console.log('   categoryAttributes keys:', Object.keys(ca).join(', '))
  const ebay = (ca.ebay ?? {}) as Record<string, unknown>
  if (Object.keys(ebay).length) console.log('   ca.ebay:', JSON.stringify(ebay).slice(0, 1500))
  const vs = (ca.variations ?? null)
  if (vs) console.log('   ca.variations:', JSON.stringify(vs).slice(0, 800))
  console.log('   FULL ca:', JSON.stringify(ca).slice(0, 2500))
}

// Full platformAttributes for one DE CL
const cl = await prisma.channelListing.findFirst({
  where: { channel: 'EBAY', region: 'DE' },
  select: { id: true, region: true, platformAttributes: true, productId: true },
})
console.log('\n=== DE ChannelListing platformAttributes keys:', Object.keys((cl?.platformAttributes ?? {}) as object).join(', '))
console.log(JSON.stringify(cl?.platformAttributes).slice(0, 3000))
await prisma.$disconnect()
