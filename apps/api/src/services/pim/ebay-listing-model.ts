const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Nexus's marker for an eBay Inventory-model listing (P3.0 census 2026-09-26: it agrees with eBay's own offers on every live item). */
export const usesEbayInventory = (facts: { listings: ReadonlyArray<{ platformAttributes: unknown }> }) =>
  facts.listings.some(l => Object.keys(object(object(l.platformAttributes).__offerIds)).length > 0 || !!object(l.platformAttributes).offerId)
