/** READ-ONLY: where are the heal correction rows for the stuck items? */
const { default: prisma } = await import('../src/db.js')
const skus = ['VENTRA-JACKET-4XL-YELLOW-MEN', 'VENTRA-JACKET-L-YELLOW-MEN', 'AIREON-JACKET-CREMA-E-VINO-MEN-XL', 'AIREON-JACKET-NERO-NEO-MEN-L', 'xavia-knee-slider-white']
const prods = await prisma.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } })
const byId = new Map(prods.map((p) => [p.id, p.sku]))
const rows = await prisma.outboundSyncQueue.findMany({
  where: { productId: { in: prods.map((p) => p.id) }, targetChannel: 'EBAY' },
  orderBy: { updatedAt: 'desc' },
  take: 40,
  select: { productId: true, syncStatus: true, errorCode: true, errorMessage: true, retryCount: true, isDead: true, nextRetryAt: true, updatedAt: true, syncType: true, createdAt: true },
})
console.log(`rows=${rows.length} now=${new Date().toISOString()}`)
for (const r of rows) {
  console.log(`${byId.get(r.productId ?? '') ?? r.productId} ${r.syncType} ${r.syncStatus}${r.isDead ? '/DEAD' : ''} rc=${r.retryCount} code=${r.errorCode ?? '-'} next=${r.nextRetryAt?.toISOString() ?? '-'} upd=${r.updatedAt.toISOString()}\n   ${(r.errorMessage ?? '').slice(0, 110)}`)
}
await prisma.$disconnect()
