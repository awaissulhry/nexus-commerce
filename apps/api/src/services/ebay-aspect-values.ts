/**
 * P1 of fix/product-sheet-editing — the values eBay receives for one item specific, in ONE place: the publisher sends
 * them and the verdict (`pim/value-verdict.ts`, via `validateChannelValue`) measures the same values, so the sheet and
 * the review never judge a value eBay would not get.
 */

/** eBay's limit for ONE value of an item specific (Trading error 21919308, Incident #26). */
export const EBAY_ASPECT_VALUE_MAX = 65

/**
 * A list sends each member (report 3 I-3.2: list values used to be dropped). A value over 65 characters that holds
 * commas or semicolons is a legacy joined list, and is sent as its parts (Incident #26). Blank members are dropped and
 * duplicates collapse; anything that is not text or a number is not an item-specific value.
 */
export function ebayAspectValues(value: unknown): string[] {
  const out: string[] = []
  for (const member of Array.isArray(value) ? value : [value]) {
    if (typeof member !== 'string' && typeof member !== 'number') continue
    const text = String(member).trim()
    if (!text) continue
    const parts = text.length > EBAY_ASPECT_VALUE_MAX && /[,;]/.test(text) ? text.split(/[,;]/).map(part => part.trim()).filter(Boolean) : [text]
    for (const part of parts) if (!out.includes(part)) out.push(part)
  }
  return out
}
