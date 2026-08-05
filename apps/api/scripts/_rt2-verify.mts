/**
 * RT.2 live verify (net-zero): two legacy-shaped Trading rows for a LIVE
 * eBay listing at its CURRENT lastQtyPushed (no quantity change on eBay).
 *  - Row 1 exercises the deployed batched dispatch → expect SUCCESS.
 *  - Row 2 (created after row 1 succeeds) fires within the 15s debounce
 *    window → expect FAILED/CIRCUIT_OPEN_DEFERRED (errorCode from the
 *    EBAY_REVISE_DEBOUNCED deferral), retryCount NOT consumed, then its
 *    deferred re-fire succeeds or is coalesced later — we cancel it at the
 *    end to leave a clean board.
 */
const { default: prisma } = await import('../src/db.js')

const mem = await prisma.sharedListingMembership.findFirst({
  where: { status: 'ACTIVE', itemId: '257629997552' }, // WATERPROOF IT (live-verified previously)
  select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true },
})
if (!mem) { console.log('no ACTIVE membership found for probe item'); process.exit(1) }
console.log(`probe: ${mem.sku}@${mem.itemId} lastQtyPushed=${mem.lastQtyPushed}`)

const mkRow = (tag: string) => prisma.outboundSyncQueue.create({
  data: {
    targetChannel: 'EBAY', targetRegion: mem.marketplace, syncType: 'QUANTITY_UPDATE',
    syncStatus: 'PENDING', externalListingId: mem.itemId, productId: mem.productId,
    payload: {
      sku: mem.sku, itemId: mem.itemId, market: mem.marketplace,
      marketplaceId: `EBAY_${mem.marketplace}`, quantity: mem.lastQtyPushed ?? 0,
      pushVia: 'TRADING', source: tag,
    },
  },
  select: { id: true },
})

const poll = async (id: string, label: string, maxSec = 180) => {
  for (let i = 0; i < maxSec / 15; i++) {
    await new Promise((r) => setTimeout(r, 15_000))
    const row = await prisma.outboundSyncQueue.findUnique({
      where: { id },
      select: { syncStatus: true, errorCode: true, retryCount: true, errorMessage: true, syncedAt: true, createdAt: true },
    })
    console.log(`  ${label} t+${(i + 1) * 15}s: ${row?.syncStatus} code=${row?.errorCode} retries=${row?.retryCount}`)
    if (row && row.syncStatus !== 'PENDING' && row.syncStatus !== 'IN_PROGRESS') {
      if (row.syncedAt) console.log(`  ${label} latency: ${Math.round((row.syncedAt.getTime() - row.createdAt.getTime()) / 100) / 10}s`)
      if (row.errorMessage) console.log(`  ${label} msg: ${row.errorMessage.slice(0, 140)}`)
      return row
    }
  }
  return null
}

const r1 = await mkRow('RT2_VERIFY_BATCH')
console.log(`row1 ${r1.id} enqueued (batched dispatch verify)…`)
const res1 = await poll(r1.id, 'row1')

if (res1?.syncStatus === 'SUCCESS') {
  const r2 = await mkRow('RT2_VERIFY_DEBOUNCE')
  console.log(`row2 ${r2.id} enqueued immediately (debounce verify)…`)
  const res2 = await poll(r2.id, 'row2', 120)
  // Clean up: cancel row2 if it's parked in deferral (don't leave it to re-fire).
  await prisma.outboundSyncQueue.updateMany({
    where: { id: r2.id, syncStatus: { in: ['PENDING', 'FAILED'] } },
    data: { syncStatus: 'CANCELLED', errorMessage: 'RT2 verify cleanup' },
  })
  console.log('row2 cleaned up (CANCELLED if still parked)')
  console.log(JSON.stringify({ batchedDispatch: res1?.syncStatus, debounce: res2?.errorCode ?? res2?.syncStatus ?? 'still-deferred(expected)' }))
} else {
  console.log('row1 did not succeed — inspect before proceeding')
}

const memAfter = await prisma.sharedListingMembership.findFirst({
  where: { itemId: mem.itemId, sku: mem.sku },
  select: { lastQtyPushed: true, lastPushedAt: true, status: true },
})
console.log('membership after:', JSON.stringify(memAfter))

await prisma.$disconnect()
process.exit(0)
