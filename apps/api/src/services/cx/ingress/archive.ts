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

export const INBOUND_SCRUB_BATCH = 500
export const INBOUND_SCRUB_MAX_BATCHES = 20

/**
 * Bounded retention for retained inbound history. Rows are never deleted (the DELETE/TRUNCATE
 * guard), so the personal data in them expires by UPDATE instead: `rawBody`, `payload` and
 * `verificationHeaders` are cleared and the metadata row (identity, verdict, status, timings)
 * stays. The window is #4's: the privacy policy's `webhookEvents` days, measured on `createdAt`,
 * the rule #4's sweep deleted rows by. It applies to
 *   - rows whose delivery was never trusted (rejected or unverified), and
 *   - archived rows (finished and archived after the same window).
 * Never touched: a row with any lease or processing claim, a scheduled row, verified work that
 * is not archived (dead letters and stranded arrivals stay replayable), and a receipt an eBay
 * quarantine row resolved to (the quarantine has its own reviewed expiry).
 */
export async function scrubExpiredInbound(days: number): Promise<{ scrubbed: number; limitReached: boolean }> {
  if (!Number.isSafeInteger(days) || days < 0) throw new Error('Inbound retention policy must be a nonnegative whole number of days.')
  const workspaceId = workspaceIdForQuery()
  let scrubbed = 0
  for (let batch = 0; batch < INBOUND_SCRUB_MAX_BATCHES; batch++) {
    const count = await prisma.$transaction(async tx => {
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      const cutoff = new Date(clock.now.getTime() - days * 86_400_000)
      if (!Number.isFinite(cutoff.getTime())) throw new Error('Inbound retention policy exceeds the supported date range.')
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT e.id FROM "WebhookEvent" e
        WHERE e."workspaceId"=${workspaceId} AND e."createdAt" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
          AND (e."rawBody" IS NOT NULL OR e."verificationHeaders" IS NOT NULL OR e.payload <> 'null'::jsonb)
          AND e."leaseToken" IS NULL AND e."leaseUntil" IS NULL AND e."processingToken" IS NULL AND e."processingUntil" IS NULL
          AND e."nextAttemptAt" IS NULL
          AND (e."archivedAt" IS NOT NULL
            OR NOT (e."signatureOk" IS TRUE OR (e."signatureOk" IS NULL AND e."verifiedBy"='sqs_iam' AND e.channel IN ('AMAZON','AMAZON_ADS')))
            OR (e.channel='EBAY' AND e."verifiedBy" IS DISTINCT FROM 'ebay_ecdsa'))
          AND NOT EXISTS (SELECT 1 FROM "EbayNoticeQuarantine" q WHERE q."resolvedReceiptId"=e.id)
        ORDER BY e."createdAt", e.id LIMIT ${INBOUND_SCRUB_BATCH} FOR UPDATE OF e SKIP LOCKED`
      if (!rows.length) return 0
      // Predicates are rechecked under the row locks taken above.
      return tx.$executeRaw`
        UPDATE "WebhookEvent" e SET "rawBody"=NULL, "verificationHeaders"=NULL, payload='null'::jsonb, "updatedAt"=${clock.now}
        WHERE e.id = ANY(${rows.map(row => row.id)}::text[]) AND e."workspaceId"=${workspaceId}
          AND e."leaseToken" IS NULL AND e."leaseUntil" IS NULL AND e."processingToken" IS NULL AND e."processingUntil" IS NULL
          AND e."nextAttemptAt" IS NULL`
    }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
    scrubbed += count
    if (count < INBOUND_SCRUB_BATCH) return { scrubbed, limitReached: false }
  }
  return { scrubbed, limitReached: true }
}
