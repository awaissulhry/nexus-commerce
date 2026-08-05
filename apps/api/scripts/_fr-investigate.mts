/** READ-ONLY: what is the real state of the 121 FR Amazon listings? */
const { default: prisma } = await import('../src/db.js')
const fr = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', marketplace: 'FR' },
  select: { listingStatus: true, isPublished: true, fulfillmentMethod: true, quantity: true, syncStatus: true, product: { select: { fulfillmentMethod: true } } },
})
console.log(`TOTAL FR AMAZON ChannelListings = ${fr.length}`)
const by = (f: (x: typeof fr[number]) => string) => { const m = new Map<string,number>(); for (const x of fr) m.set(f(x), (m.get(f(x))??0)+1); return Object.fromEntries([...m.entries()].sort()) }
console.log('by listingStatus:', by(x => x.listingStatus))
console.log('by isPublished:', by(x => String(x.isPublished)))
console.log('by fulfillmentMethod(listing):', by(x => x.fulfillmentMethod ?? 'null'))
console.log('by product.fulfillmentMethod:', by(x => x.product?.fulfillmentMethod ?? 'null'))
// FBM published FR (these SHOULD appear in an Amazon merchant/FBM report)
const fbmPublished = fr.filter(x => x.isPublished && x.listingStatus !== 'ENDED' && x.listingStatus !== 'REMOVED' &&
  (x.fulfillmentMethod === 'FBM' || (x.fulfillmentMethod == null && x.product?.fulfillmentMethod !== 'FBA')))
console.log(`\nFBM published-active FR (expected in report) = ${fbmPublished.length}`)
// Recent Amazon readback cron + any FR dead-letters
const runs = await prisma.cronRun.findMany({ where: { jobName: { contains: 'qty-readback' } }, orderBy: { startedAt: 'desc' }, take: 3, select: { startedAt: true, status: true, outputSummary: true } })
console.log('\nrecent qty-readback runs:'); for (const r of runs) console.log(`  ${r.startedAt.toISOString()} ${r.status} ${(r.outputSummary ?? '').slice(0,160)}`)
const frDead = await prisma.outboundSyncQueue.count({ where: { targetChannel: 'AMAZON', targetRegion: 'FR', isDead: true, diedAt: { gte: new Date(Date.now()-7*24*3600e3) } } })
console.log(`\nFR Amazon dead-letters (7d) = ${frDead}`)
const frReadbackLogs = await prisma.syncHealthLog.count({ where: { channel: 'AMAZON', conflictType: 'CHANNEL_QTY_READBACK', createdAt: { gte: new Date(Date.now()-7*24*3600e3) } } })
console.log(`Amazon readback mismatch logs (7d, all markets) = ${frReadbackLogs}`)
await prisma.$disconnect()
