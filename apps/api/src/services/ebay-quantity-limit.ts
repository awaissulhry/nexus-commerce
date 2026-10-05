/**
 * Max per buyer as eBay takes it — ONE rule for every eBay publisher: the studio's Trading publish
 * (`QuantityRestrictionPerBuyer`, `pim/studio-publication-ebay.ts`) and the Inventory offer the photo publish and the
 * flat-file push send (`quantityLimitPerBuyer`, `ebay-variation-push.service.ts`).
 *
 * A whole number, 1 or more, is sent. Blank (null, undefined, '', spaces) is not set. Anything else (0, 2.5, "abc") is
 * invalid: it is not sent, and the caller says so. Nexus never invents a limit (the Inventory push sent 10 for blank and
 * invalid values until wave 2, 2026-10-05).
 */
export function parseEbayQuantityLimit(value: unknown): { limit: number | null; invalid: boolean } {
  if (value == null || (typeof value === 'string' && !value.trim())) return { limit: null, invalid: false }
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return Number.isSafeInteger(n) && n >= 1 ? { limit: n, invalid: false } : { limit: null, invalid: true }
}

/** The sentence for a value eBay cannot take: `Max per buyer: eBay takes a whole number, 1 or more (this row has "abc").` */
export const ebayQuantityLimitInvalid = (value: unknown, label = 'Max per buyer') =>
  `${label}: eBay takes a whole number, 1 or more (this row has ${JSON.stringify(value)}).`

/**
 * The limit an Inventory offer body carries. eBay's updateOffer REPLACES the whole offer, so a limit left out is a limit
 * removed: ours when set; else the limit eBay holds on that offer now (`live`, eBay's getOffer answer), so a blank or
 * invalid cell keeps eBay's value — the same rule as a Trading listing; else none (a new offer gets no limit).
 */
export function offerQuantityLimit(ours: number | null, live: unknown): { quantityLimitPerBuyer?: number } {
  if (ours != null) return { quantityLimitPerBuyer: ours }
  const held = live && typeof live === 'object' ? (live as { quantityLimitPerBuyer?: unknown }).quantityLimitPerBuyer : undefined
  const { limit } = parseEbayQuantityLimit(held)
  return limit != null ? { quantityLimitPerBuyer: limit } : {}
}
