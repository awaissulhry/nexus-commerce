/**
 * Phase 1 — coalesce superseded outbound quantity rows.
 *
 * When a stock movement cascades a fresh QUANTITY_UPDATE for a listing, any
 * older PENDING QUANTITY_UPDATE rows for the same listing are now stale. Mark
 * them CANCELLED (an existing OutboundSyncStatus value that processSingle
 * already skips — same mechanism as the undo-grace) so only the latest value
 * dispatches. Targets PENDING only: never an in-flight (IN_PROGRESS) row, never
 * a non-quantity sync, never FBA-specifics (those ride the same QUANTITY_UPDATE
 * rows and are handled at dispatch by the FBA guard).
 *
 * Runs inside the caller's transaction so the cancel + the fresh insert are atomic.
 */
type CoalesceTx = {
  outboundSyncQueue: {
    updateMany: (args: unknown) => Promise<{ count: number }>
  }
}

export async function coalescePendingQuantityRows(
  tx: CoalesceTx,
  channelListingIds: string[],
): Promise<number> {
  if (channelListingIds.length === 0) return 0
  const res = await tx.outboundSyncQueue.updateMany({
    where: {
      channelListingId: { in: channelListingIds },
      syncType: 'QUANTITY_UPDATE',
      syncStatus: 'PENDING',
    },
    data: { syncStatus: 'CANCELLED' },
  })
  return res.count
}

/**
 * P4.3e — the same rule for the SHARED eBay lane, whose rows have no listing.
 *
 * A shared SKU is not a `ChannelListing`, so `coalescePendingQuantityRows`'s
 * `channelListingId IN (…)` scope never matched one and the shared fan-out
 * enqueued a fresh row beside every superseded one. The ChannelListing lane
 * learned this in P1; this lane did not — the same waterfall, the same rule,
 * applied in only one of the two builders.
 *
 * 🔴 The scope is `productId` + the ItemIDs being replaced, and BOTH halves
 * matter. One shared ItemID can carry SKUs belonging to several products, and
 * each product's fan-out writes a row covering only ITS OWN SKUs. Cancelling by
 * ItemID alone would throw away another product's pending update.
 *
 * The caller must pass only ItemIDs it is replacing in this same run
 * (cancel-scope == replace-scope), and must not call this when the fan-out was
 * narrowed to one SKU — a narrowed run cannot claim to supersede a row that may
 * carry the product's other SKUs.
 */
export async function coalescePendingSharedQuantityRows(
  tx: CoalesceTx,
  productId: string,
  itemIds: string[],
): Promise<number> {
  const targets = [...new Set(itemIds.filter((id) => typeof id === 'string' && id.trim() !== ''))]
  if (!productId || targets.length === 0) return 0
  const res = await tx.outboundSyncQueue.updateMany({
    where: {
      productId,
      // The shared lane's rows are exactly the ones with no listing.
      channelListingId: null,
      externalListingId: { in: targets },
      syncType: 'QUANTITY_UPDATE',
      syncStatus: 'PENDING',
    },
    data: { syncStatus: 'CANCELLED' },
  })
  return res.count
}
