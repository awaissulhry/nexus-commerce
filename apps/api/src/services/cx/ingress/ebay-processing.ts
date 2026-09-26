import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { inspectEbayRefreshGrant, tokenServiceEnabled } from '../token.service.js'
import { EbayGrantInspectionError } from '../ebay-grant-introspection.js'
import { ebaySellerIdentity } from '../ebay-identity.js'
import { reconcileEbayRevocationInTx, type EbayRevocationEvidence } from '../account-lifecycle.service.js'
import { claimEbayInbound, commitEbayInbound, finishEbayInbound, type EbayInboundFailure } from './ebay-claims.js'
import { raiseEbayFailureNotificationInTx } from './ebay-failure-notification.js'
import { EbayNoticeInvalid, parseEbayRevocationNotice } from './ebay-revocation-notice.js'
import { MAX_INBOUND_ATTEMPTS } from './ledger.js'
import { ebayInboundProcessingEnabled, ebayInboundProcessingReady, ebayOrderNoticesEnabled, heldEbayInboundWhere } from './ebay-processing-policy.js'

export { ebayInboundProcessingEnabled, ebayInboundProcessingReady } from './ebay-processing-policy.js'

/** Separate bounded selection prevents held/leased eBay rows starving other channels. */
export async function dueEbayInboundEvents(limit = 4) {
  if (!ebayInboundProcessingReady()) return []
  const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  return prisma.webhookEvent.findMany({ where: {
    channel: 'EBAY', signatureOk: true, verifiedBy: 'ebay_ecdsa', archivedAt: null,
    // A held order notice must not occupy one of the four slots and starve revocations.
    ...(ebayOrderNoticesEnabled() ? {} : { NOT: { eventType: 'ORDER_CONFIRMATION' } }),
    OR: [{ status: { in: ['pending', 'failed'] }, nextAttemptAt: { not: null, lte: clock.now },
      OR: [{ leaseToken: null }, { leaseUntil: { lte: clock.now } }],
    }, heldEbayInboundWhere()],
  }, select: { id: true, workspaceId: true }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: Math.max(1, Math.min(4, Math.floor(limit) || 4)) })
}

export type EbayProcessingOutcome =
  | { kind: 'held'; reason: 'processing_disabled' | 'canonical_service_required' | 'order_notices_disabled' }
  | { kind: 'not_claimed' | 'done' | 'retry' | 'deferred' | 'dead_letter' }

/** The worker and operator route use this one stored-receipt protocol. */
export async function processEbayInbound(id: string): Promise<EbayProcessingOutcome> {
  if (!ebayInboundProcessingEnabled()) return { kind: 'held', reason: 'processing_disabled' }
  if (!tokenServiceEnabled()) return { kind: 'held', reason: 'canonical_service_required' }
  // Like the processing hold: decided before any claim, so no attempt is spent and nothing dead-letters.
  if (!ebayOrderNoticesEnabled()) {
    const stored = await prisma.webhookEvent.findFirst({ where: { id, channel: 'EBAY' }, select: { eventType: true } })
    if (stored?.eventType === 'ORDER_CONFIRMATION') return { kind: 'held', reason: 'order_notices_disabled' }
  }
  const claim = await claimEbayInbound(id, raiseEbayFailureNotificationInTx)
  if (!claim) return { kind: 'not_claimed' }
  // Dispatch on the STORED event type. Loaded lazily so the revocation path's modules are unchanged.
  if (claim.eventType === 'ORDER_CONFIRMATION') {
    if (ebayOrderNoticesEnabled()) return (await import('./ebay-order-processing.js')).processEbayOrderClaim(claim)
    // Switched off after the check above: give the attempt back and keep it held, never dead-letter it.
    const saved = await finishEbayInbound(claim, { kind: 'defer', code: 'PROCESSING_HELD', reason: 'eBay order notices are held by server configuration.' })
    return saved ? { kind: 'held', reason: 'order_notices_disabled' } : { kind: 'not_claimed' }
  }
  try {
    const notice = parseEbayRevocationNotice(claim.payload)
    if (claim.eventType !== notice.topic || !claim.connectionId) throw new EbayNoticeInvalid('envelope_invalid')
    const account = await prisma.channelConnection.findFirst({ where: {
      id: claim.connectionId, workspaceId: workspaceIdForQuery(), channelType: 'EBAY', managedBy: 'oauth',
    }, select: { id: true, workspaceId: true, externalAccountId: true, connectionMetadata: true, grantVersion: true, authStatus: true } })
    if (!account) throw new EbayNoticeInvalid('subject_missing')
    const identity = ebaySellerIdentity(account)
    if (identity.userId !== notice.userId || claim.externalId !== `ebay:${identity.environment}:${notice.notificationId}`) throw new EbayNoticeInvalid('envelope_invalid')
    // Fetch outside receipt, seller and account locks. The domain phase reloads
    // stored identity and fences this evidence against the final current grant.
    const evidence: EbayRevocationEvidence = account.authStatus === 'revoked' || account.authStatus === 'disconnected'
      ? { kind: 'terminal', connectionId: account.id, workspaceId: account.workspaceId, grantVersion: account.grantVersion, authStatus: account.authStatus }
      : { kind: 'inspection', ...await inspectEbayRefreshGrant(account.id) }
    const completed = await commitEbayInbound(claim, (tx, stored) => reconcileEbayRevocationInTx(tx, stored, evidence))
    return { kind: completed.committed ? 'done' : 'not_claimed' }
  } catch (error) {
    // These reasons are static and safe for the owner-facing ledger. Provider
    // bodies, token material and arbitrary exception messages never become errors.
    const outcome: EbayInboundFailure = error instanceof EbayNoticeInvalid
      ? { kind: 'dead_letter', reason: 'The stored eBay notice cannot be reconciled with its verified account and supported contract.' }
      : error instanceof EbayGrantInspectionError && error.reason === 'rate_limited'
        ? { kind: 'defer', code: 'RATE_LIMITED', retryAfterMs: error.retryAfterMs, reason: 'eBay limited current-grant verification. Processing will resume after the hold.' }
        : { kind: 'retry', retryAfterMs: error instanceof EbayGrantInspectionError ? error.retryAfterMs : undefined,
          reason: 'The eBay authorization notice remains unresolved. Its current grant must be verified again.' }
    const saved = await finishEbayInbound(claim, outcome, raiseEbayFailureNotificationInTx)
    if (!saved) return { kind: 'not_claimed' }
    return { kind: outcome.kind === 'defer' ? 'deferred'
      : outcome.kind === 'dead_letter' || claim.attempt >= MAX_INBOUND_ATTEMPTS ? 'dead_letter' : 'retry' }
  }
}
