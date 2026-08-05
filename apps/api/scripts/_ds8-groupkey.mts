/** READ-ONLY: what group key do we actually store for Lane A families? The
 *  drift check assumed parentSku and eBay answered 25709 (bad key). */
const { default: prisma } = await import('../src/db.js')
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
for (const sku of ['AIRMESH-JACKET', 'GALE-JACKET', 'IT-MOSS-JACKET']) {
  const root = await prisma.product.findFirst({ where: { sku, parentId: null, deletedAt: null }, select: { id: true, sku: true } })
  if (!root) { console.log(`${sku}: no root`); continue }
  const kids = await prisma.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: { id: true } })
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: [root.id, ...kids.map(k => k.id)] }, channel: 'EBAY' },
    select: { productId: true, region: true, externalListingId: true, platformAttributes: true },
  })
  console.log(`\n═══ ${sku} ═══`)
  for (const cl of cls) {
    const a = asObj(cl.platformAttributes)
    const keys = Object.keys(a)
    const interesting = keys.filter(k => /group|offer|inventory/i.test(k))
    if (interesting.length) {
      console.log(`  ${cl.region}/${cl.externalListingId ?? '-'} attrs:`,
        interesting.map(k => `${k}=${JSON.stringify(a[k]).slice(0, 120)}`).join('  '))
    }
  }
}
await prisma.$disconnect()
