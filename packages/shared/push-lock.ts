export interface PushLockListing {
  syncPaused?: boolean | null
  offerClosedAt?: Date | string | null
  /** Optional until the Presence Wave 2 migration has been applied. */
  presenceIntent?: string | null
  /** `ChannelListing.listingStatus`: DRAFT / ACTIVE / INACTIVE / ENDED / ERROR (P1.7). */
  listingStatus?: string | null
  /** Set by the Presence migration; until it is applied, `listingStatus` is the only ended signal. */
  endedAt?: Date | string | null
}

export type PushRefusal = {
  code: 'PUSH_SYNC_PAUSED' | 'PUSH_OFFER_CLOSED' | 'PUSH_INTENT_HELD' | 'PUSH_INTENT_WITHDRAWN'
    | 'PUSH_INTENT_ENDED' | 'PUSH_INTENT_DISCONTINUED' | 'PUSH_INTENT_RELEASED' | 'PUSH_LISTING_ENDED'
  sentence: string
}

/** The same lock at enqueue, dispatch and direct push; a refusal is recordable, never thrown. */
export function assertPushAllowed(listing: PushLockListing | null | undefined): PushRefusal | null {
  if (listing?.syncPaused) return { code: 'PUSH_SYNC_PAUSED', sentence: 'Listing sync is paused. Resume sync before sending changes.' }
  if (listing?.offerClosedAt) return { code: 'PUSH_OFFER_CLOSED', sentence: 'This market offer is closed. Restore the offer before sending changes.' }
  switch (listing?.presenceIntent) {
    case 'HELD': return { code: 'PUSH_INTENT_HELD', sentence: 'This listing is deliberately held. Resume sync before sending changes.' }
    case 'WITHDRAWN': return { code: 'PUSH_INTENT_WITHDRAWN', sentence: 'This offer is deliberately withdrawn. Restore the offer before sending changes.' }
    case 'ENDED': return { code: 'PUSH_INTENT_ENDED', sentence: 'This listing was deliberately ended. Relist it before sending changes.' }
    case 'DISCONTINUED': return { code: 'PUSH_INTENT_DISCONTINUED', sentence: 'This listing is discontinued. Sending changes is refused.' }
    case 'RELEASED': return { code: 'PUSH_INTENT_RELEASED', sentence: 'This listing identity was deliberately released. Sending changes is refused.' }
  }
  // P1.7 — an ENDED listing cannot come back through an ordinary push. Presence's intent columns are not
  // in the generated client yet, so the listing's own status is the signal that works today; `endedAt`
  // arrives with the Presence migration and is honoured the moment it does.
  if (listing?.endedAt || String(listing?.listingStatus ?? '').trim().toUpperCase() === 'ENDED') {
    return { code: 'PUSH_LISTING_ENDED', sentence: 'This listing is ended on the channel. Relist it before sending changes.' }
  }
  return null
}

/** The facts that say whether a listing is still a Nexus draft. */
export interface DraftListingFacts {
  listingStatus?: string | null
  isPublished?: boolean | null
  externalListingId?: string | null
}

/**
 * A still-draft listing, as a database filter: DRAFT, never marked published, and no channel id. The same rule as
 * `isStillDraftListing`, for a `where` — a push-lock test pins that the two agree.
 */
export const STILL_DRAFT_LISTING = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null } as const

/**
 * THE rule for "this listing is still a Nexus draft": it has never been published to the channel. Publish may send
 * it while it is paused, and a channel's acceptance turns it live (published, ACTIVE, unpaused). Anything else — a
 * live listing, a DRAFT row a creator left `isPublished: true`, a row with a channel id — is not a still-draft, and a
 * missing fact counts as "not a draft", so the pause keeps holding it.
 */
export function isStillDraftListing(listing: DraftListingFacts | null | undefined): boolean {
  return !!listing && listing.listingStatus === STILL_DRAFT_LISTING.listingStatus
    && listing.isPublished === STILL_DRAFT_LISTING.isPublished && listing.externalListingId == null
}

/**
 * The lock for PUBLISH only (the studio review and the channel publishers it drives). A still-draft's pause is what
 * keeps the draft inert — no cascade or dispatch sends it — not an operator's hold on a live listing, and Publish is
 * the one action allowed to send a draft. So for a still-draft the pause is not a refusal here; every other lock
 * (a closed offer, a Presence intent, an ended listing) still is. Any other paused listing is refused exactly as by
 * `assertPushAllowed`, which every other caller keeps using: dispatch must go on refusing a paused draft.
 */
export function assertPublishAllowed(listing: (PushLockListing & DraftListingFacts) | null | undefined): PushRefusal | null {
  if (listing?.syncPaused && isStillDraftListing(listing)) return assertPushAllowed({ ...listing, syncPaused: false })
  return assertPushAllowed(listing)
}
