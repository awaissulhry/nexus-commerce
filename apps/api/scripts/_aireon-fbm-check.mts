/** READ-ONLY: why are AIREON's converted rows still not pushing? Check every
 *  FBA-evidence signal per variant + the push trigger state. */
const { default: prisma } = await import('../src/db.js')
const masters = await prisma.product.findMany({
  where: { sku: { contains: 'AIREON' }, parentId: null, deletedAt: null },
  select: { id: true, sku: true, fulfillmentMethod: true },
})
console.log('masters:', masters.map((m) => `${m.sku} (product.fm=${m.fulfillmentMethod ?? 'null'})`).join(' · '))
for (const m of masters) {
  const kids = await prisma.product.findMany({
    where: { parentId: m.id, deletedAt: null },
    select: { id: true, sku: true, fulfillmentMethod: true },
  })
  const ids = [m.id, ...kids.map((k) => k.id)]
  const all = [m, ...kids]
  // signals per variant with an IT Amazon listing
  const cls = await prisma.channelListing.findMany({
    where: { productId: { in: ids }, channel: 'AMAZON', marketplace: 'IT', isPublished: true },
    select: {
      productId: true, fulfillmentMethod: true, platformAttributes: true,
      followMasterQuantity: true, quantity: true, syncPaused: true, offerClosedAt: true, lastSyncStatus: true, lastSyncedAt: true,
    },
  })
  const fbaStock = await prisma.stockLevel.findMany({
    where: { productId: { in: ids }, location: { code: 'AMAZON-EU-FBA' } },
    select: { productId: true, quantity: true },
  })
  const fbaStockBy = new Map(fbaStock.map((s) => [s.productId, s.quantity]))
  const offers = await prisma.offer.findMany({
    where: { channelListing: { productId: { in: ids } }, fulfillmentMethod: 'FBA', isActive: true },
    select: { channelListing: { select: { productId: true } } },
  }).catch(() => [])
  const fbaOfferSet = new Set(offers.map((o) => o.channelListing?.productId))
  let locked = 0, unlocked = 0
  const detail: string[] = []
  for (const cl of cls) {
    const p = all.find((x) => x.id === cl.productId)
    const fa = String((cl.platformAttributes as any)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase()
    const signals = {
      listingFm: cl.fulfillmentMethod === 'FBA',
      channelCode: fa.startsWith('AMAZON'),
      productFm: String(p?.fulfillmentMethod ?? '').toUpperCase() === 'FBA',
      fbaStock: (fbaStockBy.get(cl.productId) ?? 0) > 0,
      fbaOffer: fbaOfferSet.has(cl.productId),
    }
    const isLocked = Object.values(signals).some(Boolean)
    if (isLocked) { locked++; detail.push(`  ${p?.sku}: LOCKED by [${Object.entries(signals).filter(([, v]) => v).map(([k]) => k).join(', ')}] fbaStock=${fbaStockBy.get(cl.productId) ?? 0}`) }
    else { unlocked++; if (detail.length < 40) detail.push(`  ${p?.sku}: UNLOCKED follow=${cl.followMasterQuantity} qty=${cl.quantity} lastSync=${cl.lastSyncStatus} at=${cl.lastSyncedAt?.toISOString()?.slice(11, 16) ?? 'never'}`) }
  }
  console.log(`\n${m.sku}: IT rows=${cls.length} · LOCKED=${locked} · UNLOCKED=${unlocked}`)
  for (const d of detail.slice(0, 30)) console.log(d)
}
await prisma.$disconnect()
