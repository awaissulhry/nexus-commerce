/**
 * The order a family is published in: the parent first, then its variations by SKU. ONE comparator, used by the
 * publisher (`readPublicationFacts`, whose order `buildSharedListingInput` reads first-value-wins) and by every reader
 * that must name the row the publisher reads first (`ebay-listing-level.ts`): two sorts that disagree name different rows.
 */
export function familyPublicationOrder<T extends { sku: string }>(isParent: (row: T) => boolean): (a: T, b: T) => number {
  return (a, b) => Number(isParent(b)) - Number(isParent(a)) || a.sku.localeCompare(b.sku)
}
