const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
const all = await prisma.listingImage.findMany({ where: { productId: p!.id, platform: 'EBAY' }, select: { mediaType: true, variantGroupKey: true } })
const byType: Record<string, number> = {}
for (const r of all) byType[String(r.mediaType)] = (byType[String(r.mediaType)] ?? 0) + 1
console.log('ALL EBAY rows:', all.length, ' by mediaType:', JSON.stringify(byType))
const filtered = await prisma.listingImage.count({ where: { productId: p!.id, platform: 'EBAY', mediaType: 'IMAGE' } })
console.log(`rows the PUBLISH query actually returns (mediaType:'IMAGE'): ${filtered}`)
console.log(filtered === 0 ? '❌ ZERO → imageOverrideByColor EMPTY → every variant falls back to Amazon images' : '✅ query returns rows')
await prisma.$disconnect()
