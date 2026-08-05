/** P0 — force-deliver current quantities: the takeover unblocked dispatch but
 *  cascade only enqueues on DELTA; rows whose correct qty was written while
 *  blocked never re-enqueued. Enqueue a push for every live+published FBM
 *  Amazon row with qty>0 (dispatch re-reads + clamps; FBA guard intact).
 *  DRY-RUN default; --apply. */
const apply = process.argv.includes('--apply')
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON', isPublished: true, offerActive: true,
    listingStatus: { in: ['ACTIVE', 'BUYABLE', 'DISCOVERABLE'] },
    quantity: { gt: 0 },
  },
  select: { id: true, productId: true, marketplace: true, quantity: true, externalListingId: true, fulfillmentMethod: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const fbm = rows.filter((l) => !((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA')))
const pending = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'QUANTITY_UPDATE', syncStatus: { in: ['PENDING', 'IN_PROGRESS'] }, channelListingId: { in: fbm.map((l) => l.id) } },
  select: { channelListingId: true },
})
const hasPending = new Set(pending.map((p) => p.channelListingId))
const targets = fbm.filter((l) => !hasPending.has(l.id))
console.log(`live published FBM qty>0 rows: ${fbm.length}; already pending: ${hasPending.size}; to enqueue: ${targets.length}`)
const fam = (s: string) => (s.match(/^([A-Za-z]+)/)?.[1] ?? s).toUpperCase()
const agg = new Map<string, number>()
for (const t of targets) agg.set(fam(t.product?.sku ?? '?'), (agg.get(fam(t.product?.sku ?? '?')) ?? 0) + 1)
for (const [f, n] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${f}: ${n}`)
if (!apply) { console.log('DRY-RUN'); await prisma.$disconnect(); process.exit(0) }
let created = 0
for (const t of targets) {
  await prisma.outboundSyncQueue.create({
    data: {
      productId: t.productId, channelListingId: t.id, targetChannel: 'AMAZON',
      targetRegion: t.marketplace, syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING',
      externalListingId: t.externalListingId ?? undefined,
      payload: { quantity: t.quantity, source: 'P0_FORCE_RESYNC' },
    },
  })
  created++
}
console.log(`enqueued: ${created}`)
await prisma.$disconnect()
process.exit(0)
