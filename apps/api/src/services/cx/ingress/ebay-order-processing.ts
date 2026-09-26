/**
 * Stored ORDER_CONFIRMATION execution — DORMANT. Admission still quarantines this topic and its
 * subscription stays `handlerMissing`, so production cannot deliver a receipt here; this is the
 * executor that activation will need, proved locally first.
 *
 * One receipt names one order on one account. The order is read back with THAT account's own
 * token, once, before any lock or transaction (never a list, never a sweep of other accounts);
 * then the shared order writer and the receipt completion commit in one transaction.
 */
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { ebaySellerIdentity, EbayIdentityChanged } from '../ebay-identity.js'
import { EbayOrderAttributionConflict, EbayOrderInvalid, afterEbayOrderCommit, normalizeEbayOrder, writeEbayOrderInTx } from '../../ebay-order-writer.js'
import { EbayOrderFetchError, fetchEbayOrderById } from '../../ebay-orders.service.js'
import { commitEbayInbound, finishEbayInbound, type EbayInboundClaim, type EbayInboundFailure } from './ebay-claims.js'
import { raiseEbayFailureNotificationInTx } from './ebay-failure-notification.js'
import { EbayOrderNoticeInvalid, parseEbayOrderNotice } from './ebay-order-notice.js'
import { MAX_INBOUND_ATTEMPTS } from './ledger.js'
import type { EbayProcessingOutcome } from './ebay-processing.js'

/** Static, owner-safe reasons: provider bodies and exception text never become the public error. */
export function ebayOrderFailureOf(error: unknown): EbayInboundFailure {
  if (error instanceof EbayOrderNoticeInvalid || error instanceof EbayOrderInvalid) {
    return { kind: 'dead_letter', reason: 'The stored eBay order notice cannot be reconciled with its verified account and supported contract.' }
  }
  if (error instanceof EbayOrderAttributionConflict) {
    return { kind: 'dead_letter', reason: error.reason === 'account_missing'
      ? 'The eBay account on this notice is not an eBay account of this business profile. Nothing was changed.'
      : 'This eBay order is recorded for a different eBay seller. It was not changed.' }
  }
  if (error instanceof EbayOrderFetchError && error.reason === 'rate_limited') {
    return { kind: 'defer', code: 'RATE_LIMITED', retryAfterMs: error.retryAfterMs, reason: 'eBay limited order reads. Processing will resume after the hold.' }
  }
  if (error instanceof EbayOrderFetchError && error.reason === 'auth_required') {
    return { kind: 'defer', code: 'AUTH_REQUIRED', reason: 'The eBay account must be reconnected before this order can be read.' }
  }
  return { kind: 'retry', retryAfterMs: error instanceof EbayOrderFetchError ? error.retryAfterMs : undefined,
    reason: error instanceof EbayIdentityChanged
      ? 'The eBay seller authorization changed. The order will be read again.'
      : 'The eBay order could not be recorded yet. It will be read again.' }
}

/** Called by processEbayInbound with a claim it already owns. */
export async function processEbayOrderClaim(claim: EbayInboundClaim): Promise<EbayProcessingOutcome> {
  try {
    const notice = parseEbayOrderNotice(claim.payload)
    if (claim.eventType !== notice.topic || !claim.connectionId) throw new EbayOrderNoticeInvalid('envelope_invalid')
    // Exactly the receipt's account, in this profile — never "the active accounts".
    const account = await prisma.channelConnection.findFirst({ where: {
      id: claim.connectionId, workspaceId: workspaceIdForQuery(), channelType: 'EBAY', managedBy: 'oauth',
    }, select: { id: true, externalAccountId: true, connectionMetadata: true } })
    if (!account) throw new EbayOrderNoticeInvalid('account_missing')
    const identity = ebaySellerIdentity(account)
    if (claim.externalId !== `ebay:${identity.environment}:${notice.notificationId}`) throw new EbayOrderNoticeInvalid('envelope_invalid')
    const order = normalizeEbayOrder(await fetchEbayOrderById(account.id, notice.orderId, { environment: identity.environment }))
    if (order.orderId !== notice.orderId) throw new EbayOrderNoticeInvalid('order_mismatch')
    const completed = await commitEbayInbound(claim, (tx, stored) => {
      // The domain phase trusts only the receipt reloaded under its lock, not the claim handle.
      if (stored.connectionId !== account.id || parseEbayOrderNotice(stored.payload).orderId !== order.orderId) throw new EbayOrderNoticeInvalid('envelope_invalid')
      return writeEbayOrderInTx(tx, { order, connectionId: account.id, actor: 'ebay-order-notice' })
    })
    if (!completed.committed) return { kind: 'not_claimed' }
    await afterEbayOrderCommit(completed.value!)
    return { kind: 'done' }
  } catch (error) {
    const outcome = ebayOrderFailureOf(error)
    const saved = await finishEbayInbound(claim, outcome, raiseEbayFailureNotificationInTx)
    if (!saved) return { kind: 'not_claimed' }
    return { kind: outcome.kind === 'defer' ? 'deferred'
      : outcome.kind === 'dead_letter' || claim.attempt >= MAX_INBOUND_ATTEMPTS ? 'dead_letter' : 'retry' }
  }
}
