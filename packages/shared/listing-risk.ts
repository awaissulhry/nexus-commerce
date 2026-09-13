export interface ListingIdentityRow {
  externalListingId?: string | null
}

const trimmed = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')

/** isLiveOnChannel's predicate unchanged: an external ID is held regardless of local status. */
export function identityHeld(row: ListingIdentityRow): boolean {
  return trimmed(row.externalListingId) !== ''
}

/** Intent and observation remain separate. A SELLING observation overrides terminal intent. */
export function sellingRisk(row: ListingIdentityRow & { presenceIntent?: string | null; channelFact?: string | null }): boolean {
  return (identityHeld(row) && !['ENDED', 'DISCONTINUED', 'RELEASED'].includes(row.presenceIntent ?? ''))
    || row.channelFact === 'SELLING'
}
