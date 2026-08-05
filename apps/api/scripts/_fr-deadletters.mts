/** READ-ONLY: WHY are FR Amazon pushes dead-lettering / the report empty? */
const { default: prisma } = await import('../src/db.js')
const dead = await prisma.outboundSyncQueue.findMany({
  where: { targetChannel: 'AMAZON', targetRegion: 'FR', isDead: true, diedAt: { gte: new Date(Date.now()-7*24*3600e3) } },
  select: { errorMessage: true, errorCode: true, syncType: true, diedAt: true, product: { select: { sku: true } } },
  orderBy: { diedAt: 'desc' }, take: 24,
})
const byErr = new Map<string, number>()
for (const d of dead) { const k = `${d.errorCode ?? '-'} | ${(d.errorMessage ?? '').slice(0,120)}`; byErr.set(k, (byErr.get(k)??0)+1) }
console.log('FR DEAD-LETTER errors (7d):')
for (const [k,n] of [...byErr.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  [${n}] ${k}`)
console.log('\nsample SKUs:', dead.slice(0,5).map(d=>d.product?.sku).join(', '))

// Compare: do IT pushes for the SAME products succeed? (isolates FR-specific vs product-specific)
const frSkus = [...new Set(dead.map(d=>d.product?.sku).filter(Boolean))].slice(0,3) as string[]
for (const sku of frSkus) {
  const itListing = await prisma.channelListing.findFirst({ where: { channel:'AMAZON', marketplace:'IT', product: { sku } }, select: { listingStatus: true, syncStatus: true } })
  const frListing = await prisma.channelListing.findFirst({ where: { channel:'AMAZON', marketplace:'FR', product: { sku } }, select: { listingStatus: true, syncStatus: true, externalListingId: true } })
  console.log(`  ${sku}: IT=${JSON.stringify(itListing)}  FR=${JSON.stringify(frListing)}`)
}
await prisma.$disconnect()
