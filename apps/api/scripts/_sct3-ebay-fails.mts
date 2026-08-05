/** READ-ONLY: classify the eBay FOLLOW push failures from the verification. */
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 20 * 60 * 1000)
const rows = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', targetChannel: 'EBAY', createdAt: { gte: since }, syncStatus: 'FAILED' },
  select: { id: true, errorMessage: true, retryCount: true, maxRetries: true, payload: true, product: { select: { sku: true } } },
})
const classes = new Map<string, string[]>()
for (const r of rows) {
  const m = r.errorMessage ?? ''
  const cls = m.includes('debounced') ? 'DEBOUNCE (self-retries)' : (m.match(/errorId":(\d+)/)?.[1] ?? m.slice(0, 40))
  const sku = r.product?.sku ?? (r.payload as any)?.productId ?? '?'
  classes.set(cls, [...(classes.get(cls) ?? []), `${sku} (retry ${r.retryCount}/${r.maxRetries})`])
}
for (const [cls, skus] of classes) {
  console.log(`\n[${cls}] × ${skus.length}`)
  for (const s of skus.slice(0, 6)) console.log(`   ${s}`)
}
// full text of one 400
const ex = rows.find((r) => r.errorMessage?.includes('400'))
if (ex) console.log(`\nfull 400 example:\n${ex.errorMessage?.slice(0, 500)}`)
await prisma.$disconnect()
