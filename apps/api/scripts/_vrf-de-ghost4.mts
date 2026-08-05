const { default: prisma } = await import('../src/db.js')
const cls = await prisma.channelListing.findMany({ where: { channel: 'EBAY', region: 'DE' }, select: { createdAt: true, updatedAt: true, product: { select: { sku: true } } }, orderBy: { updatedAt: 'desc' } })
for (const c of cls) console.log(`${c.product?.sku} created=${c.createdAt.toISOString()} updated=${c.updatedAt.toISOString()}`)
await prisma.$disconnect()
