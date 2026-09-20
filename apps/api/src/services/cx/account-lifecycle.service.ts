/**
 * P2.6 — one way for an account to become revoked.
 *
 * Most of this package already existed and worked, which the measurement had to
 * establish before anything was written:
 *
 *   - The gateway ALREADY pauses writes. `gateway.ts` refuses any call whose account is
 *     inactive or whose `authStatus` is `needs_reauth`, `revoked` or `disconnected`, and
 *     HOLDS it rather than sending.
 *   - `transition()` in token.service.ts ALREADY is the state machine: it guards the
 *     terminal states, writes with a compare-and-set so two racing signals cannot both
 *     "win", records a `ConnectionEvent`, and raises a CONNECTION_HEALTH alert for
 *     `needs_reauth` and `revoked`.
 *   - Amazon's `invalid_grant` and Etsy's refresh 401 ALREADY reach it: both classify as
 *     `auth_revoked`, `statusAfterConnectionFailure` maps that to `needs_reauth`, and
 *     `failRefresh` announces the transition.
 *
 * Two signals did not. eBay's `AUTHORIZATION_REVOCATION` was recorded and left (P2.3
 * said P2.6 would act on it). Shopify's `app/uninstalled` wrote
 * `authStatus: "revoked"` with a raw `updateMany` — set in P2.4, in this same
 * programme — which skips the compare-and-set, the ConnectionEvent and, most of all,
 * **the alert**. An account silently revoking itself is the failure this package is
 * supposed to end, not one it should introduce.
 *
 * So there is no new state machine here. There is one function that both signals call,
 * and a guard that stops the next person writing the column by hand.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { transition } from './token.service.js'

/** Where a revocation came from. Recorded so an operator can tell them apart. */
export type RevokeSource =
  | 'ebay_authorization_revocation'
  | 'shopify_app_uninstalled'
  | 'operator'

export interface RevokeOutcome {
  ok: boolean
  connectionId: string
  /** Set when nothing changed, with the reason. */
  skipped?: 'not_found' | 'already_terminal'
  previousStatus?: string
}

/**
 * Mark one connection revoked, through the state machine.
 *
 * Deliberately takes a connection ID and nothing vaguer. A revoke that has to work out
 * WHICH account it means is how the wrong seller gets cut off the day a second one is
 * connected — the MAP.3 ratchet refuses those lookups for exactly this reason, and a
 * revocation is the most damaging place to get it wrong. Callers resolve the account
 * from the routing index first (`verifiedChannelWorkspace`), which matches the names
 * the CHANNEL sends.
 */
export async function revokeChannelConnection(
  connectionId: string,
  reason: string,
  source: RevokeSource,
): Promise<RevokeOutcome> {
  const row = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, channelType: true, authStatus: true, displayName: true },
  })
  if (!row) {
    // Loud: a revocation naming an account we cannot find is either a routing defect or
    // a notification for somebody else's application, and both are worth seeing.
    logger.error('[account-lifecycle] revocation names an account that does not exist here', { connectionId, source })
    return { ok: false, connectionId, skipped: 'not_found' }
  }
  if (row.authStatus === 'revoked' || row.authStatus === 'disconnected') {
    return { ok: true, connectionId, skipped: 'already_terminal', previousStatus: row.authStatus }
  }

  await transition(row, 'revoked', reason)
  // `isActive` is not part of the state machine, and it is what the routing trigger
  // keys on: leaving it true would keep the account in the inbound routing index after
  // its grant is gone. Written after the transition so a failed transition cannot leave
  // an account inactive but still reading as connected.
  await prisma.channelConnection.updateMany({
    where: { id: row.id },
    data: { isActive: false, lastError: reason.slice(0, 500), lastErrorAt: new Date() },
  })
  logger.error('[account-lifecycle] account revoked — writes are held from now on', {
    connectionId, channelType: row.channelType, source, previousStatus: row.authStatus,
  })
  return { ok: true, connectionId, previousStatus: row.authStatus }
}
