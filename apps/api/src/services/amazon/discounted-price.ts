/**
 * CHMAP M7 (B1) — the one shape of an Amazon sale price, for every path that sends one (the Listings PATCH in
 * `outbound-sync.service.ts` and the flat-file feed). The cached Listings-Items schema has no `sale_price`; a sale is
 * `purchasable_offer.discounted_price[].schedule[]{ start_at, end_at, value_with_tax }`, all three required (measured on
 * IT/UK/DE, MX.1 phase 0(c)). A sale without both dates is never emitted: Amazon would reject the schedule entry.
 */
export function amazonDiscountedPrice(value: number | null | undefined, start: unknown, end: unknown): Array<{ schedule: Array<{ start_at: string; end_at: string; value_with_tax: number }> }> | null {
  if (value == null || !start || !end) return null
  return [{ schedule: [{ start_at: String(start), end_at: String(end), value_with_tax: value }] }]
}
