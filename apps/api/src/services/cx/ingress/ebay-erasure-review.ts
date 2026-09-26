import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { activeDatabaseTransaction } from '../../../lib/database-context.js'
import { legacyIngress, withIngressWorkspace } from '../../../lib/workspace-ingress.js'
import { workspaceContext } from '../../../lib/workspace-context.js'
import { raiseChannelAlertInTx } from '../channel-alerts.service.js'
import { ebaySellerIdentity } from '../ebay-identity.js'
import { openEbayQuarantineBody } from './ebay-quarantine-crypto.js'
import { readEbayNoticeIdentity } from './ebay-revocation-notice.js'

export const EBAY_PRIVACY_REVIEW_ENV = 'NEXUS_ENABLE_EBAY_PRIVACY_REVIEW'
/** Notices reviewed per retry-worker tick. The worker, not eBay's HTTP answer, pays for review. */
export const EBAY_DELETION_REVIEW_BATCH = 10
// A claim is a lease: a worker that dies mid-review leaves the notice due again afterwards.
const REVIEW_LEASE_SECONDS = 600
// Unreadable subject data stays retained and is rechecked daily, so a later reader can review it.
const UNSUPPORTED_RECHECK_SECONDS = 86_400
const retrySeconds = (attempt: number) => Math.min(60 * 2 ** Math.max(0, attempt - 1), 21_600)
// Prisma stores DateTime as UTC wall time; compare and write in the same frame.
const utcNow = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value)

export class EbayErasureReviewError extends Error {
  constructor(readonly code: 'authority_denied' | 'review_unavailable') {
    super('The eBay privacy review could not be recorded.'); this.name = 'EbayErasureReviewError'
  }
}

interface DeletionSubject { userId: string | null; username: string | null }

/** The original authenticated notice supplies the subject: eBay's immutable user ID and, when sent, the username. */
function candidateSubject(payload: unknown, externalId: string): DeletionSubject | null {
  try {
    const identity = readEbayNoticeIdentity(payload)
    const root = object(payload), metadata = object(root?.metadata), data = object(object(root?.notification)?.data)
    if (identity.topic !== 'MARKETPLACE_ACCOUNT_DELETION' || identity.notificationId !== externalId || metadata?.schemaVersion !== '1.0' || !data
      || (data.userId !== undefined && !identifier(data.userId)) || (data.username !== undefined && !identifier(data.username))
      || (data.eiasToken !== undefined && !identifier(data.eiasToken))) return null
    const subject = { userId: identifier(data.userId) ? data.userId : null, username: identifier(data.username) ? data.username : null }
    return subject.userId || subject.username ? subject : null
  } catch { return null }
}

/**
 * Order data stores only the Fulfillment API's buyer.username, and eBay puts the immutable user ID
 * in that field for some U.S. buyers. So the immutable ID is tried first, across every account;
 * the mutable username is only a fallback. The rule that matched is recorded.
 */
const matchRules = (subject: DeletionSubject) => [
  ...(subject.userId ? [{ basis: 'user_id', value: subject.userId }] : []),
  ...(subject.username ? [{ basis: 'username', value: subject.username }] : []),
]

/** Workspace → request key → account → order. Never take an account lock after an order lock. */
async function recordCandidate(workspaceId: string, quarantineId: string, environment: string, subject: DeletionSubject) {
  return withIngressWorkspace(workspaceId, () => prisma.$transaction(async tx => {
    const active = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Workspace" WHERE id=${workspaceId} AND status='active' FOR SHARE`
    if (!active.length) return { created: 0, notices: 0, matched: 0 }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['ebay-erasure-review', workspaceId, quarantineId])},0))`
    for (const rule of matchRules(subject)) {
      const matches = Prisma.sql`o."workspaceId"=${workspaceId} AND o.channel='EBAY'
        AND jsonb_typeof(o."ebayMetadata"->'buyer'->'username')='string' AND o."ebayMetadata"->'buyer'->>'username'=${rule.value}`
      let after: string | null = null
      while (true) {
        const [account] = await tx.$queryRaw<Array<{ id: string; externalAccountId: string | null; connectionMetadata: unknown }>>`
          SELECT c.id,c."externalAccountId",c."connectionMetadata" FROM "ChannelConnection" c
          WHERE c."workspaceId"=${workspaceId} AND c."channelType"='EBAY' AND c."managedBy"='oauth'
            AND c."connectionMetadata"->>'environment'=${environment}
            ${after ? Prisma.sql`AND c.id>${after}` : Prisma.empty}
            AND EXISTS (SELECT 1 FROM "Order" o WHERE ${matches} AND o."channelConnectionId"=c.id)
          ORDER BY c.id LIMIT 1 FOR SHARE OF c`
        if (!account) break
        after = account.id
        try { if (ebaySellerIdentity(account).environment !== environment) continue } catch { continue }
        // A separate statement sees changes committed while the account lock waited.
        const [order] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT o.id FROM "Order" o WHERE ${matches} AND o."channelConnectionId"=${account.id} ORDER BY o.id LIMIT 1 FOR SHARE OF o`
        if (!order) continue
        const existing = await tx.erasureRequest.findUnique({ where: { workspace_quarantine: { workspaceId, quarantineId } } })
        const request = existing ?? await tx.erasureRequest.create({ data: { quarantineId, evidenceOrderId: order.id,
          channel: 'EBAY', environment, matchBasis: rule.basis, status: 'REVIEW_REQUIRED' } })
        const notice = await raiseChannelAlertInTx(tx, { kind: 'channel-privacy-review', severity: 'warn',
          title: 'An eBay privacy notice needs review',
          body: 'Retained buyer information may match an eBay privacy notice. Identity is unverified and fiscal retention needs a decision. No data has been erased.',
          entityType: 'ErasureRequest', entityId: request.id, href: '/settings/privacy', meta: { erasureRequestId: request.id },
        }, { occurrenceId: `erasure-review:${request.id}`, actorUserId: null })
        return { created: existing ? 0 : 1, notices: notice.created, matched: 1 }
      }
    }
    return { created: 0, notices: 0, matched: 0 }
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 }))
}

/** System work only: never a user, API key or someone else's open transaction. */
function refuseDirectAuthority() {
  const context = workspaceContext()
  if (context?.actorUserId || context?.apiKeyId || context?.membershipId || activeDatabaseTransaction()) throw new EbayErasureReviewError('authority_denied')
}

/** Internal verified-ingress entry only; caller payloads and requested workspace IDs are never accepted. */
export async function reviewEbayDeletion(quarantineId: string) {
  if (process.env[EBAY_PRIVACY_REVIEW_ENV] !== '1') return { kind: 'held' as const, reason: 'processing_disabled' as const }
  refuseDirectAuthority()
  if (!identifier(quarantineId)) throw new EbayErasureReviewError('review_unavailable')
  try {
    const stored = await legacyIngress(() => prisma.ebayNoticeQuarantine.findUnique({ where: { id: quarantineId } }))
    if (!stored || !stored.signatureOk || stored.topic !== 'MARKETPLACE_ACCOUNT_DELETION' || stored.resolvedReceiptId !== null) {
      return { kind: 'held' as const, reason: 'notice_unavailable' as const }
    }
    // Decryption is outside database locks; immutable proof/digest binds this to the first retained body.
    const rawBody = await openEbayQuarantineBody(stored)
    let subject: DeletionSubject | null
    try { subject = candidateSubject(JSON.parse(rawBody.toString('utf8')), stored.externalId) } finally { rawBody.fill(0) }
    if (!subject) return { kind: 'held' as const, reason: 'subject_unavailable' as const }
    let after: string | undefined, workspacesExamined = 0, workspacesMatched = 0, requestsCreated = 0, noticesCreated = 0
    do {
      // Read IDs in bounded pages; only an exact local data match can produce a request or notice.
      const workspaces = await legacyIngress(() => prisma.workspace.findMany({ where: { status: 'active', ...(after ? { id: { gt: after } } : {}) },
        select: { id: true }, orderBy: { id: 'asc' }, take: 50 }))
      for (const workspace of workspaces) {
        const result = await recordCandidate(workspace.id, stored.id, stored.environment, subject)
        workspacesExamined++; workspacesMatched += result.matched; requestsCreated += result.created; noticesCreated += result.notices
      }
      after = workspaces.length === 50 ? workspaces[workspaces.length - 1].id : undefined
    } while (after)
    return { kind: 'candidates_recorded' as const, workspacesExamined, workspacesMatched, requestsCreated, noticesCreated }
  } catch { throw new EbayErasureReviewError('review_unavailable') }
}

/**
 * The retry worker's half of acknowledge-first: reviews stored deletion notices after eBay has its 2xx.
 * Claims are compare-and-set leases; failures back off (1 min doubling to 6 h) and are never dropped.
 */
export async function reviewPendingEbayDeletions(limit = EBAY_DELETION_REVIEW_BATCH) {
  if (process.env[EBAY_PRIVACY_REVIEW_ENV] !== '1') return { kind: 'held' as const, reason: 'processing_disabled' as const }
  refuseDirectAuthority()
  const take = Math.max(1, Math.min(EBAY_DELETION_REVIEW_BATCH, Math.floor(limit) || EBAY_DELETION_REVIEW_BATCH))
  const stats = { claimed: 0, reviewed: 0, unsupported: 0, failed: 0 }
  const due = await legacyIngress(() => prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "EbayNoticeQuarantine" WHERE "signatureOk"=true AND topic='MARKETPLACE_ACCOUNT_DELETION' AND "resolvedReceiptId" IS NULL
      AND "reviewedAt" IS NULL AND ("reviewNextAt" IS NULL OR "reviewNextAt" <= ${utcNow})
    ORDER BY "reviewNextAt" NULLS FIRST, "receivedAt", id LIMIT ${take}`)
  for (const { id } of due) {
    try {
      const [claim] = await legacyIngress(() => prisma.$queryRaw<Array<{ attempts: number }>>`
        UPDATE "EbayNoticeQuarantine" SET "reviewAttempts"="reviewAttempts"+1, "reviewNextAt"=${utcNow} + make_interval(secs => ${REVIEW_LEASE_SECONDS}::int)
        WHERE id=${id} AND "reviewedAt" IS NULL AND ("reviewNextAt" IS NULL OR "reviewNextAt" <= ${utcNow})
        RETURNING "reviewAttempts" AS attempts`)
      if (!claim) continue
      stats.claimed++
      let outcome: Awaited<ReturnType<typeof reviewEbayDeletion>> | null = null
      try { outcome = await reviewEbayDeletion(id) } catch { /* static error; retried with backoff below */ }
      const unsupported = outcome?.kind === 'held' && outcome.reason === 'subject_unavailable'
      const finish = outcome?.kind === 'candidates_recorded'
        ? Prisma.sql`"reviewedAt"=${utcNow}, "reviewOutcome"=${outcome.workspacesMatched > 0 ? 'matched' : 'unmatched'}, "reviewNextAt"=NULL`
        : unsupported
          ? Prisma.sql`"reviewOutcome"='unsupported', "reviewNextAt"=${utcNow} + make_interval(secs => ${UNSUPPORTED_RECHECK_SECONDS}::int)`
          : Prisma.sql`"reviewNextAt"=${utcNow} + make_interval(secs => ${retrySeconds(claim.attempts)}::int)`
      await legacyIngress(() => prisma.$executeRaw`UPDATE "EbayNoticeQuarantine" SET ${finish} WHERE id=${id}`)
      if (outcome?.kind === 'candidates_recorded') stats.reviewed++
      else if (unsupported) stats.unsupported++
      else stats.failed++
    } catch { stats.failed++ }
  }
  return { kind: 'reviewed' as const, ...stats }
}

/**
 * Days a deletion notice is kept after its review finished, once no business still has an open
 * request for it (it matched nothing, or every request is DISMISSED/COMPLETED). eBay asks for the
 * user's data to be deleted unless a specific legal need requires keeping it; such a notice has
 * none. The window only covers eBay redeliveries of the same notice, operator audit of the review
 * and eBay's own 30-day compliance window. Unreviewed, unreadable and open notices never expire
 * here. The database refuses anything shorter (floor in workspaces/ebay-erasure-review.sql).
 */
export const EBAY_DELETION_NOTICE_RETENTION_DAYS = 30
const EXPIRY_BATCH = 500
const EXPIRY_MAX_BATCHES = 20

/** Retention-path entry (one platform tick): bounded batches through the restricted database function. */
export async function expireEbayDeletionNotices(batch = EXPIRY_BATCH) {
  if (process.env[EBAY_PRIVACY_REVIEW_ENV] !== '1') return { kind: 'held' as const, reason: 'processing_disabled' as const }
  refuseDirectAuthority()
  const size = Math.max(1, Math.min(EXPIRY_BATCH, Math.floor(batch) || EXPIRY_BATCH))
  let expired = 0
  for (let round = 0; round < EXPIRY_MAX_BATCHES; round++) {
    const [row] = await legacyIngress(() => prisma.$queryRaw<Array<{ expired: number }>>`
      SELECT nexus_expire_ebay_deletion_notices(${EBAY_DELETION_NOTICE_RETENTION_DAYS}::int, ${size}::int) AS expired`)
    expired += row.expired
    if (row.expired < size) return { kind: 'expired' as const, expired, limitReached: false }
  }
  return { kind: 'expired' as const, expired, limitReached: true }
}

export type EbayErasureDecision = 'HELD' | 'DISMISSED'

/**
 * An active owner decides an undecided candidate. HELD: it is this buyer; erasure waits for the
 * fiscal-retention decision and an approved executor (the only writer of COMPLETED). DISMISSED:
 * not this buyer; the record is done. The database guard re-checks owner and transition at write.
 */
export async function decideEbayErasureRequest(requestId: string, decision: EbayErasureDecision) {
  const context = workspaceContext()
  if (!context?.actorUserId || context.apiKeyId || activeDatabaseTransaction()) throw new EbayErasureReviewError('authority_denied')
  const owner = await prisma.workspaceMembership.findFirst({ where: { workspaceId: context.workspaceId, userId: context.actorUserId,
    status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } }, select: { id: true } })
  if (!owner) throw new EbayErasureReviewError('authority_denied')
  let decided: { id: string; status: EbayErasureDecision } | null
  try {
    decided = await prisma.$transaction(async tx => {
      // RLS hides other businesses' requests; the guard refuses any request that is not undecided.
      const [row] = await tx.$queryRaw<Array<{ id: string; status: EbayErasureDecision }>>`
        UPDATE "ErasureRequest" SET status=${decision} WHERE id=${requestId} RETURNING id, status`
      if (!row) return null
      await tx.workspaceAudit.create({ data: { workspaceId: context.workspaceId, actorUserId: context.actorUserId,
        action: 'ebay.erasure.decided', targetId: row.id, metadata: { status: row.status } } })
      return row
    }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
  } catch { throw new EbayErasureReviewError('review_unavailable') }
  if (!decided) throw new EbayErasureReviewError('review_unavailable')
  return decided
}
