/** READ-ONLY: DE listings' platformAttributes.categoryId + product-level eBay category. */
const { default: prisma } = await import('../src/db.js')

const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', region: 'DE' },
  select: { id: true, region: true, platformAttributes: true, flatFileSnapshot: true, product: { select: { sku: true, parentId: true, categoryAttributes: true } } },
})
for (const c of cls) {
  const pa = (c.platformAttributes ?? {}) as Record<string, unknown>
  const snap = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  console.log(`${c.product?.sku} paCategoryId=${String(pa.categoryId ?? '-')} snapCat=${String(snap.category_id ?? '-')} variationTheme=${String(pa.variationTheme ?? snap.variation_theme ?? '-')}`)
}
await prisma.$disconnect()
