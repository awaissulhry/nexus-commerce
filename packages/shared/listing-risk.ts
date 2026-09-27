export interface ListingIdentityRow {
  externalListingId?: string | null
  /** With `isPublished` and `listingStatus`: the facts `isAsinPending` reads. A caller that omits them gets the id rule alone. */
  channel?: string | null
  isPublished?: boolean | null
  listingStatus?: string | null
}

const trimmed = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')

/**
 * The listing statuses that say Amazon has the listing: `ACTIVE` is what Publish writes when Amazon accepts the feed,
 * `BUYABLE` and `DISCOVERABLE` are Amazon's own summary statuses, stored as Amazon reports them.
 */
export const AMAZON_LIVE_STATUSES: readonly string[] = ['ACTIVE', 'BUYABLE', 'DISCOVERABLE']

/**
 * Published on Amazon, ASIN not read back yet. Amazon's feed report accepts a SKU without naming its ASIN, so a row
 * Publish promoted (published, ACTIVE) has no `externalListingId` until the ASIN filler reads it from Amazon. Such a
 * row is not a draft and not a local record: Amazon holds the listing.
 *
 * Amazon only. An eBay row's identity is its ItemID, and eBay rules keep reading the id alone.
 */
export function isAsinPending(row: ListingIdentityRow | null | undefined): boolean {
  return !!row && trimmed(row.channel).toUpperCase() === 'AMAZON' && row.isPublished === true
    && AMAZON_LIVE_STATUSES.includes(trimmed(row.listingStatus).toUpperCase()) && trimmed(row.externalListingId) === ''
}

/** isLiveOnChannel's predicate: an external ID is held regardless of local status, and so is an Amazon listing whose ASIN is pending. */
export function identityHeld(row: ListingIdentityRow): boolean {
  return trimmed(row.externalListingId) !== '' || isAsinPending(row)
}

/** Intent and observation remain separate. A SELLING observation overrides terminal intent. */
export function sellingRisk(row: ListingIdentityRow & { presenceIntent?: string | null; channelFact?: string | null }): boolean {
  return (identityHeld(row) && !['ENDED', 'DISCONTINUED', 'RELEASED'].includes(row.presenceIntent ?? ''))
    || row.channelFact === 'SELLING'
}
