const { default: prisma } = await import('../src/db.js')
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', region: 'DE' },
  select: { flatFileSnapshot: true, product: { select: { sku: true, categoryAttributes: true } } },
})
for (const c of cls) {
  const snap = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  const catKeys = Object.keys(snap).filter((k) => /categ/i.test(k))
  console.log(c.product?.sku, '| snapshot category keys:', JSON.stringify(catKeys.map((k) => [k, snap[k]])), '| theme:', snap.variation_theme)
}
await prisma.$disconnect()
