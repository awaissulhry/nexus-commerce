/**
 * RT.5.1 — OWNER-DIRECTED (2026-07-20): set ALL FBM listings to Follow.
 * "For all the FBM listings, set to follow."
 *
 * Dry-run default prints the impact table (pinned qty vs pool → delta).
 * --apply executes via setFollowMasterQuantity (FBA skipped fail-closed by
 * the service; ENDED excluded; Following listings are no-op'd server-side).
 * Runs per channel over the distinct productIds of currently-PINNED
 * non-ENDED listings.
 */
const apply = process.argv.includes('--apply')
const { default: prisma } = await import('../src/db.js')
const { setFollowMasterQuantity } = await import('../src/services/follow-master.service.js')

const pinned = await prisma.channelListing.findMany({
  where: {
    channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] },
    followMasterQuantity: false,
    listingStatus: { not: 'ENDED' },
  },
  select: {
    channel: true, marketplace: true, quantity: true, quantityOverride: true,
    stockBuffer: true, fulfillmentMethod: true, productId: true, listingStatus: true,
    product: { select: { sku: true, fulfillmentMethod: true } },
  },
})
const fbm = pinned.filter(
  (l) => !(l.channel === 'AMAZON' && ((l.fulfillmentMethod === 'FBA') || (l.fulfillmentMethod == null && l.product?.fulfillmentMethod === 'FBA'))),
)
console.log(`Pinned non-ENDED listings: ${pinned.length} (FBM approx: ${fbm.length}; FBA-classified are also sent — service skips them fail-closed)`)

const pools = await prisma.stockLevel.groupBy({
  by: ['productId'], where: { location: { type: 'WAREHOUSE' } }, _sum: { available: true },
})
const poolBy = new Map(pools.map((p) => [p.productId, p._sum.available ?? 0]))

let up = 0, down = 0, same = 0
const samples: string[] = []
for (const l of fbm) {
  const cur = l.quantityOverride ?? l.quantity ?? 0
  const target = Math.max(0, (poolBy.get(l.productId) ?? 0) - (l.stockBuffer ?? 0))
  if (target > cur) up++
  else if (target < cur) down++
  else same++
  if (samples.length < 12 && target !== cur) {
    samples.push(`${l.product?.sku}@${l.channel}:${l.marketplace} ${l.listingStatus} pinned=${cur} → follow=${target}`)
  }
}
console.log(`impact: qty RISES on ${up}, DROPS on ${down}, unchanged on ${same}`)
for (const s of samples) console.log('  ', s)

if (!apply) {
  console.log('\nDRY-RUN — re-run with --apply to execute.')
  await prisma.$disconnect()
  process.exit(0)
}

for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY'] as const) {
  const ids = [...new Set(pinned.filter((l) => l.channel === channel).map((l) => l.productId))]
  if (!ids.length) { console.log(`${channel}: nothing pinned`); continue }
  let updated = 0, skippedFba = 0, unchanged = 0, failedChunks = 0
  for (let i = 0; i < ids.length; i += 1) {
    const chunk = ids.slice(i, i + 1)
    try {
      const res = await setFollowMasterQuantity({
        productIds: chunk,
        channel,
        markets: 'ALL',
        follow: true,
        actor: 'rt5-unpin-all-fbm (owner-directed 2026-07-20)',
      })
      updated += res.updated; skippedFba += res.skippedFba; unchanged += res.unchanged
      console.log(`  ${channel} chunk ${i + 1}/${ids.length}: updated=${res.updated} skippedFba=${res.skippedFba} unchanged=${res.unchanged}`)
    } catch (err) {
      failedChunks++
      const e = err as { message?: string; code?: string; meta?: unknown; name?: string }
      console.log(`  ${channel} chunk ${i + 1} FAILED name=${e?.name} code=${e?.code} msg=${String(e?.message ?? err).slice(0, 200)} meta=${JSON.stringify(e?.meta ?? null).slice(0, 150)} skus=${chunk.join(',').slice(0, 120)}`)
    }
  }
  console.log(`${channel}: updated=${updated} skippedFba=${skippedFba} unchanged=${unchanged} failedChunks=${failedChunks}`)
}

const stillPinned = await prisma.channelListing.count({
  where: { channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] }, followMasterQuantity: false, listingStatus: { not: 'ENDED' } },
})
console.log(`\nverify: still-pinned non-ENDED listings = ${stillPinned} (expect ≈ FBA count only)`)
await prisma.$disconnect()
process.exit(0)
