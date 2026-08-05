/** READ-ONLY: is ANY_OFFER_CHANGED a usable qty-drop trigger? All-time analysis. */
const { default: prisma } = await import('../src/db.js')
const ourSeller = process.env.AMAZON_SELLER_ID ?? ''
const aoc = await prisma.webhookEvent.findMany({
  where: { channel: 'AMAZON', eventType: 'ANY_OFFER_CHANGED' },
  select: { createdAt: true, payload: true }, orderBy: { createdAt: 'asc' },
})
console.log(`ANY_OFFER_CHANGED all-time: ${aoc.length}`)
if (aoc.length) console.log(`  window: ${aoc[0].createdAt.toISOString()} → ${aoc[aoc.length-1].createdAt.toISOString()}`)
let absent = 0, present = 0, oosFlagged = 0
for (const e of aoc) {
  const root = (e.payload as any)?.Payload?.AnyOfferChangedNotification ?? (e.payload as any)?.Payload?.AnyOfferChanged
  if (!root) continue
  const offers: any[] = Array.isArray(root.Offers) ? root.Offers : []
  const mine = offers.find((o) => o.SellerId === ourSeller)
  if (mine) { present++; if (mine.IsFulfilledByAmazon === false) oosFlagged++ } else absent++
}
console.log(`  our offer present ${present} / absent ${absent} (MFN offers among present: ${oosFlagged})`)

// The 8 stuck SKUs — do we get AOC events for their ASINs at all?
const stuck = ['YK-29A3-CH9D','SQ-75VQ-OZ1Q','SQ-0SRL-MWT1','85-A8DQ-UNYF','AE-304M-9LSW','MISANO-JACKET-3XL-BLACK','MISANO-JACKET-4XL-BLACK','MISANO-JACKET-5XL-BLACK']
const stuckCls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', product: { sku: { in: stuck } } },
  select: { externalListingId: true, marketplace: true, quantity: true, product: { select: { sku: true } } },
})
const stuckAsins = new Set(stuckCls.map((c) => c.externalListingId).filter(Boolean) as string[])
console.log(`\nstuck SKUs → ${stuckAsins.size} distinct ASINs:`, [...stuckAsins].slice(0, 8).join(' '))
let hits = 0
for (const e of aoc) {
  const root = (e.payload as any)?.Payload?.AnyOfferChangedNotification ?? (e.payload as any)?.Payload?.AnyOfferChanged
  const asin = root?.OfferChangeTrigger?.ASIN ?? root?.OfferChangeTrigger?.Asin
  if (asin && stuckAsins.has(asin)) hits++
}
console.log(`AOC events touching a stuck ASIN: ${hits}`)
await prisma.$disconnect()
