/**
 * VTR step 0b — what an eBay flat-file row save writes into `ChannelListing.platformAttributes`.
 *
 * A row OWNS exactly the fields `packSharedFields` builds from it (category, subtitle, item specifics, images, policies, …) and
 * wins on those, a cleared one included. Every other key on the listing belongs to another writer and survives: the Inventory
 * offer ids (`__offerIds`, the lane marker), the variation setup (`_variationAxes*`, `_axisNameLabels`, `_axisValueOrder`),
 * publish receipts (`__lastPublishedAxes`, `descriptionPush`, …). The save used to replace the whole bag and erase them.
 */
export function flatFileListingAttributes(stored: unknown, packed: Record<string, unknown>): Record<string, unknown> {
  const kept = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {}
  return { ...kept, ...packed }
}
