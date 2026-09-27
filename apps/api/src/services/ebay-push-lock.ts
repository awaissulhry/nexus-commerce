import { assertPublishAllowed, assertPushAllowed, isStillDraftListing, type DraftListingFacts, type PushLockListing, type PushRefusal } from '@nexus/shared/push-lock'

/**
 * The push lock over every eBay row of the pushed SKUs on this account. eBay keeps ONE inventory item per SKU across
 * its sites, so a push can touch a sibling site's offer: an operator's pause, a closed offer, an intent or an ended
 * listing on ANY site blocks it. A still-draft (`isStillDraftListing`: never published, no ItemID) has no offer on eBay.
 * On another site there is nothing to touch, so its pause — which only keeps the draft inert — never blocks. On the
 * pushed site it is sent only by an explicit publish (`publishesDrafts`: the flat-file Push), the one action allowed to
 * send a draft (`assertPublishAllowed`); recording the result (`recordLiveListings`) then lifts its pause.
 */
export function familyPushRefusal(
  rows: ReadonlyArray<PushLockListing & DraftListingFacts & { marketplace?: string | null }>,
  market: string,
  publishesDrafts = false,
): PushRefusal | null {
  const site = market.toUpperCase() === 'GB' ? 'UK' : market.toUpperCase()
  for (const row of rows) {
    const rowSite = String(row.marketplace ?? '').toUpperCase() === 'GB' ? 'UK' : String(row.marketplace ?? '').toUpperCase()
    const refusal = isStillDraftListing(row) && (rowSite !== site || publishesDrafts) ? assertPublishAllowed(row) : assertPushAllowed(row)
    if (refusal) return refusal
  }
  return null
}
