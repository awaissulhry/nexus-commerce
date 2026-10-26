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
 * The one inbound topic whose stored body has a short life even when the delivery was never handled — failed, dead-
 * lettered, or for a shop with no route (Shopify marketing consent, 2026-10-26: the body holds a person's plain e-mail,
 * and the consent service keeps only a hash). A handled delivery's body is cleared at once (claims.ts
 * CLEAR_BODY_WHEN_DONE); an unhandled one is cleared by this sweep once it is older than `days`, whatever the privacy
 * policy's window, by the same UPDATE and under the same lease guards. After that the delivery can no longer be
 * replayed by hand (it has no body). That matters for a redacted customer: the late-replay marker (the customers/redact
 * notice, marketing-consent.service.ts redactedOnThisAccount) lives only for the policy's window, and once the sweep has
 * cleared it, it can no longer protect a redacted customer from a hand-replay — so the consent delivery's own body must
 * be gone first. Every other topic is unchanged.
 */
export const SHORT_LIVED_INBOUND = { channel: 'SHOPIFY', eventType: 'customers_email_marketing_consent/update', days: 7 } as const

/**
 * Bounded retention for retained inbound history. Rows are never deleted (the DELETE/TRUNCATE
 * guard), so the personal data in them expires by UPDATE instead: `rawBody`, `payload` and
 * `verificationHeaders` are cleared and the metadata row (identity, verdict, status, timings)
 * stays. The window is #4's: the privacy policy's `webhookEvents` days, measured on `createdAt`,
 * the rule #4's sweep deleted rows by. It applies to
 *   - rows whose delivery was never trusted (rejected or unverified), and
 *   - archived rows (finished and archived after the same window).
 * Never touched: a row with any lease or processing claim, a scheduled row, verified work that
 * is not archived (dead letters and stranded arrivals stay replayable) — except SHORT_LIVED_INBOUND's
 * topic after its own days —, and a receipt an eBay quarantine row resolved to (the quarantine has its
 * own reviewed expiry).
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
      const shortCutoff = new Date(clock.now.getTime() - SHORT_LIVED_INBOUND.days * 86_400_000)
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT e.id FROM "WebhookEvent" e
        WHERE e."workspaceId"=${workspaceId}
          AND (e."rawBody" IS NOT NULL OR e."verificationHeaders" IS NOT NULL OR e.payload <> 'null'::jsonb)
          AND e."leaseToken" IS NULL AND e."leaseUntil" IS NULL AND e."processingToken" IS NULL AND e."processingUntil" IS NULL
          AND e."nextAttemptAt" IS NULL
          AND ((e."createdAt" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
              AND (e."archivedAt" IS NOT NULL
                OR NOT (e."signatureOk" IS TRUE OR (e."signatureOk" IS NULL AND e."verifiedBy"='sqs_iam' AND e.channel IN ('AMAZON','AMAZON_ADS')))
                OR (e.channel='EBAY' AND e."verifiedBy" IS DISTINCT FROM 'ebay_ecdsa')))
            OR (e.channel=${SHORT_LIVED_INBOUND.channel} AND e."eventType"=${SHORT_LIVED_INBOUND.eventType}
              AND e."createdAt" < (${shortCutoff}::timestamptz AT TIME ZONE 'UTC')))
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
