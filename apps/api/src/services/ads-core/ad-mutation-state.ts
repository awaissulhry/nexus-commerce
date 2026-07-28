/**
 * AX-ZD.1 — the state vocabulary for a typed ad mutation.
 *
 * Ad writes ride `OutboundSyncQueue`, a product/listing model: `productId`,
 * `channelListingId`, `externalListingId`, and no campaign, ad-group or target
 * foreign key. The entity and the changed fields live inside a JSON payload.
 *
 * The live consequence is in the drift check. Its pending-write lookup is a
 * campaign-wide JSON-path scan, computed ONCE and then passed as
 * `hasPendingWrite` for every field diff — so one queued budget change
 * classifies a *name* edit made in Seller Central as `WRITE_PENDING` and hides
 * it. There is no field column to scope on, so the scan could not have been
 * written any other way.
 *
 * `AdMutation` gives one row per (entity, field), which makes that lookup
 * field-scoped. This module is the pure part: the states, which of them mean
 * "still in flight", and how long an unsettled row deserves to be believed.
 *
 * Pure: no I/O. Unit-tested.
 */

export const AD_MUTATION_STATES = [
  'PENDING', 'IN_FLIGHT', 'APPLIED', 'FAILED', 'CANCELLED', 'SUPERSEDED',
] as const
export type AdMutationState = (typeof AD_MUTATION_STATES)[number]

/** Not yet resolved — a write that may still reach Amazon. */
export const IN_FLIGHT_STATES = ['PENDING', 'IN_FLIGHT'] as const

/** Resolved, one way or another. Nothing further will happen to these. */
export const TERMINAL_STATES = ['APPLIED', 'FAILED', 'CANCELLED', 'SUPERSEDED'] as const

export function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state)
}

/**
 * How long a non-terminal row is trusted to still mean "in flight".
 *
 * This is a deliberate safety bound, not a timeout. Settlement is driven by the
 * worker, and if a settlement write is ever missed — a crash between the Amazon
 * call and the local update, a code path added later that forgets — the row sits
 * PENDING forever. Without a bound, that one stuck row would suppress drift
 * detection on its field permanently, which is a strictly worse failure than the
 * campaign-wide scan it replaces: silent, unbounded, and invisible.
 *
 * 24h is far longer than the grace period plus the full retry ladder
 * (2^n minutes to `maxRetries`), so it cannot fire on a healthy write. Past it,
 * we stop believing the row and let drift surface. Failing toward "show the
 * operator a possible external edit" is the correct direction to be wrong in.
 */
export const PENDING_TRUST_WINDOW_MS = 24 * 60 * 60 * 1000

export function isBelievablyPending(
  row: { state: string; createdAt: Date },
  now: Date = new Date(),
): boolean {
  if (isTerminal(row.state)) return false
  return now.getTime() - row.createdAt.getTime() < PENDING_TRUST_WINDOW_MS
}

/**
 * Map an `OutboundSyncQueue` status onto a mutation state.
 *
 * OutboundSyncQueue remains the dispatch path (AX-ZD.1 is additive — moving
 * dispatch is a separate, verifiable step), so its status is the source of
 * truth and this is the projection.
 *
 * The one asymmetry worth naming: a queue row goes back to `PENDING` between
 * retries, and that is genuinely still in flight, so it maps to `PENDING` and
 * not to `FAILED`. Only a dead row — retries exhausted — is terminal. Marking a
 * retryable transient as FAILED would let drift re-open on a field we are still
 * actively writing.
 */
export function stateForQueueStatus(syncStatus: string, isDead = false): AdMutationState {
  if (isDead) return 'FAILED'
  switch (syncStatus) {
    case 'PENDING': return 'PENDING'
    case 'IN_PROGRESS': return 'IN_FLIGHT'
    case 'SUCCESS': return 'APPLIED'
    case 'FAILED': return 'FAILED'
    case 'CANCELLED': return 'CANCELLED'
    // A gate denial or a local-only no-op never reached Amazon, so the intent
    // was abandoned rather than attempted-and-failed. CANCELLED says that.
    case 'SKIPPED': return 'CANCELLED'
    default: return 'PENDING'
  }
}
