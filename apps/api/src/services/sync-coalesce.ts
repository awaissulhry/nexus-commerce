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
