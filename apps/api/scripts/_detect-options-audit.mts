/** READ-ONLY: audit EVERY available detection signal already flowing into Nexus. */
const { default: prisma } = await import('../src/db.js')
const day = 24 * 3600e3
const ourSeller = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
console.log('our sellerId:', ourSeller ? ourSeller.slice(0, 6) + '***' : '(unset locally)')

// ── 1. FEED_PROCESSING_FINISHED — does it fire for feeds we did NOT submit? ──
const feedEvents = await prisma.webhookEvent.findMany({
  where: { channel: 'AMAZON', eventType: 'FEED_PROCESSING_FINISHED' },
  orderBy: { createdAt: 'desc' }, take: 20,
  select: { createdAt: true, payload: true },
})
console.log(`\n=== FEED_PROCESSING_FINISHED events ever received: ${feedEvents.length > 0 ? '' : 'NONE'} ===`)
const ourFeedIds = new Set(
  (await prisma.amazonImageFeedJob.findMany({ select: { feedId: true } })).map((f) => f.feedId).filter(Boolean) as string[],
)
for (const e of feedEvents.slice(0, 10)) {
  const p = e.payload as any
  const n = p?.Payload?.FeedProcessingFinishedNotification ?? p?.Payload?.FeedProcessingFinished ?? {}
  const fid = n.FeedId ?? n.feedId ?? '?'
  console.log(`  ${e.createdAt.toISOString()} feedId=${fid} type=${n.FeedType ?? '?'} status=${n.ProcessingStatus ?? '?'} ourFeed=${ourFeedIds.has(fid)}`)
}

// ── 2. ANY_OFFER_CHANGED — already flowing. Is it a usable qty-change trigger? ──
const aoc = await prisma.webhookEvent.findMany({
  where: { channel: 'AMAZON', eventType: 'ANY_OFFER_CHANGED', createdAt: { gte: new Date(Date.now() - 7 * day) } },
  select: { createdAt: true, payload: true },
})
let withOurOffer = 0, withoutOurOffer = 0
const asins = new Set<string>()
const asinsWhereWeVanished = new Set<string>()
for (const e of aoc) {
  const root = (e.payload as any)?.Payload?.AnyOfferChangedNotification ?? (e.payload as any)?.Payload?.AnyOfferChanged
  if (!root) continue
  const asin = root.OfferChangeTrigger?.ASIN ?? root.OfferChangeTrigger?.Asin ?? ''
  if (asin) asins.add(asin)
  const offers: any[] = Array.isArray(root.Offers) ? root.Offers : []
  const mine = ourSeller ? offers.find((o) => o.SellerId === ourSeller) : null
  if (mine) withOurOffer++
  else { withoutOurOffer++; if (asin) asinsWhereWeVanished.add(asin) }
}
console.log(`\n=== ANY_OFFER_CHANGED last 7d: ${aoc.length} events, ${asins.size} distinct ASINs ===`)
console.log(`  our offer PRESENT in payload: ${withOurOffer}`)
console.log(`  our offer ABSENT  in payload: ${withoutOurOffer}  (${asinsWhereWeVanished.size} distinct ASINs)`)

// Do those ASINs map to OUR FBM listings? (i.e. is AOC a usable trigger for our SKUs?)
const allAsins = [...asins]
const ourListings = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', externalListingId: { in: allAsins } },
  select: { externalListingId: true, marketplace: true, quantity: true, product: { select: { sku: true } } },
})
console.log(`  ASINs from AOC that match one of OUR ChannelListings: ${new Set(ourListings.map((l) => l.externalListingId)).size} of ${asins.size}`)

// ── 3. What identifies an Amazon listing row? Check how ASIN is stored. ──
const sample = await prisma.channelListing.findFirst({
  where: { channel: 'AMAZON', isPublished: true },
  select: { externalListingId: true, platformAttributes: true, product: { select: { sku: true } } },
})
console.log('\nsample Amazon ChannelListing identity:', JSON.stringify({
  externalListingId: sample?.externalListingId, sku: sample?.product?.sku,
}))

// ── 4. Subscriptions actually live right now ──
const boot = await prisma.cronRun.findMany({
  where: { jobName: { contains: 'notification' } },
  orderBy: { startedAt: 'desc' }, take: 5,
  select: { jobName: true, startedAt: true, status: true, outputSummary: true },
})
console.log('\n=== notification setup self-reports ===')
for (const b of boot) console.log(`  ${b.startedAt.toISOString()} ${b.jobName} ${b.status} ${String(b.outputSummary ?? '').slice(0, 200)}`)
await prisma.$disconnect()
