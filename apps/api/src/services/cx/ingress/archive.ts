import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'

export const INBOUND_ARCHIVE_BATCH = 500

/** Logical archive only: the original receipt, payload and verification remain stored. */
export async function archiveCompletedInbound(days: number): Promise<{ archived: number; limitReached: boolean }> {
  if (!Number.isSafeInteger(days) || days < 0) throw new Error('Inbound archive policy must be a nonnegative whole number of days.')
  const workspaceId = workspaceIdForQuery()
  return prisma.$transaction(async tx => {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    const cutoff = new Date(clock.now.getTime() - days * 86_400_000)
    if (!Number.isFinite(cutoff.getTime())) throw new Error('Inbound archive policy exceeds the supported date range.')
    // SKIP LOCKED permits another archiver/replay to make progress. Predicates are
    // rechecked under row locks; a replayed old receipt is unfinished and ineligible.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "WebhookEvent"
      WHERE "workspaceId"=${workspaceId} AND status='done' AND "isProcessed"=true
        AND "processedAt" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
        AND "archivedAt" IS NULL AND "nextAttemptAt" IS NULL AND "leaseToken" IS NULL AND "leaseUntil" IS NULL
        AND "processingToken" IS NULL AND "processingUntil" IS NULL
      ORDER BY "processedAt", id LIMIT ${INBOUND_ARCHIVE_BATCH} FOR UPDATE SKIP LOCKED`
    if (!rows.length) return { archived: 0, limitReached: false }
    const saved = await tx.webhookEvent.updateMany({ where: { id: { in: rows.map(row => row.id) }, workspaceId,
      status: 'done', isProcessed: true, processedAt: { lt: cutoff }, archivedAt: null,
      nextAttemptAt: null, leaseToken: null, leaseUntil: null, processingToken: null, processingUntil: null,
    }, data: { archivedAt: clock.now } })
    return { archived: saved.count, limitReached: rows.length === INBOUND_ARCHIVE_BATCH }
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
}
