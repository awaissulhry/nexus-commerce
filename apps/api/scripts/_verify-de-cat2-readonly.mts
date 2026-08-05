// READ-ONLY. No writes.
const { default: prisma } = await import('../src/db.js')
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', region: 'DE' },
  select: { productId: true, platformAttributes: true },
})
for (const cl of cls) {
  const pa = (cl.platformAttributes ?? {}) as Record<string, unknown>
  const p = await prisma.product.findUnique({ where: { id: cl.productId }, select: { sku: true, parentId: true } })
  console.log(`${p?.sku}  parent=${p?.parentId ? 'child' : 'PARENT'}  categoryId="${String(pa.categoryId ?? '')}"  specifics=${JSON.stringify(pa.itemSpecifics ?? {})}`)
}
await prisma.$disconnect()
