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

/**
 * Selling is paused here (the product sheet's Status column shows **Inactive**): `offerClosedAt` is set by a Pause offer
 * (eBay, Shopify and Etsy: reason `sheet-pause`, `SHEET_PAUSE_REASON` in listing-actions) or by Amazon's per-market
 * offer close. Every quantity writer leaves such a listing alone: the push lock below refuses its pushes, and the
 * writers that build a quantity themselves (Sync Control, the Matrix, Claude's stock tools, the old eBay flat-file Push)
 * ask this first. Only Resume offer (Status → Active, then Publish) lifts it, and Resume sends the current stock.
 */
export function sellingPaused(listing: Pick<PushLockListing, 'offerClosedAt'> | null | undefined): boolean {
  return !!listing?.offerClosedAt
}

/** What a quantity writer says when it leaves a listing with paused selling alone. */
export const SELLING_PAUSED_SENTENCE = 'Inactive here (selling is paused), so Nexus sends it no quantity. Change it in the product sheet\'s Status column.'

/** The same lock at enqueue, dispatch and direct push; a refusal is recordable, never thrown. */
export function assertPushAllowed(listing: PushLockListing | null | undefined): PushRefusal | null {
  if (listing?.syncPaused) return { code: 'PUSH_SYNC_PAUSED', sentence: 'Listing sync is paused. Resume sync before sending changes.' }
  if (listing?.offerClosedAt) return { code: 'PUSH_OFFER_CLOSED', sentence: 'This listing is Inactive here (selling is paused). Set it Active in the product sheet\'s Status column before sending changes.' }
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

/** The facts that recognise an eBay listing an OLDER close-listing paused (`isOldClosePause`). */
export interface OldClosePauseFacts {
  channel?: string | null
  listingStatus?: string | null
  offerClosedAt?: Date | string | null
  followMasterQuantity?: boolean | null
  quantityOverride?: number | null
  quantity?: number | null
  /** Presence columns (raw-SQL migration 20260913180000_pr_presence; not in the generated client — read them raw). */
  endedAt?: Date | string | null
  endedReason?: string | null
}

/**
 * An eBay listing that Claude's OLD close-listing paused (MCP full control L9, 2026-10-02 until build shape v2): it pinned
 * the quantity at 0 through the Matrix (`followMasterQuantity: false`, 0) and wrote the presence mark `endedAt`, with no
 * hold (`offerClosedAt` stays empty). It is paused, not ended: eBay keeps the item at quantity 0 (out-of-stock control
 * on, which that close required), so it reads **Inactive**, and Resume must lift the pin (back to Follow, as the old
 * reopen did) and clear the mark. A channel-file delete (`endedReason: 'channel-file-delete'`, catalog-transfer.service)
 * also writes `endedAt` and is not a pause; a listing the channel ended, or one held by the sheet's own Pause, is
 * not this either. A pin that was later changed to a number above 0 or to Follow is no longer a pause.
 */
export function isOldClosePause(listing: OldClosePauseFacts | null | undefined): boolean {
  if (!listing || String(listing.channel ?? '').toUpperCase() !== 'EBAY') return false
  if (!listing.endedAt || listing.endedReason === 'channel-file-delete' || listing.offerClosedAt) return false
  if (String(listing.listingStatus ?? '').trim().toUpperCase() === 'ENDED') return false
  return listing.followMasterQuantity === false && (listing.quantityOverride ?? listing.quantity) === 0
}
