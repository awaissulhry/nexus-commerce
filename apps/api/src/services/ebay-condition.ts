/**
 * eBay condition translation — ONE table, both directions, both APIs.
 *
 * The operator writes enum-style words (NEW, USED_EXCELLENT…) in the flat
 * file's condition column:
 *  - the Inventory API wants exactly those words;
 *  - the Trading API (AddFixedPriceItem — extra shared listings) wants the
 *    numeric ConditionID (1000, 3000…).
 * Incident #16 (2026-07-18): the Trading path passed the word through raw and
 * eBay failed with code 37 ("Item.ConditionID is invalid"). The operator must
 * NEVER have to know which API a push takes — translation happens here, and
 * both services read this module so the tables cannot drift.
 */

/** Numeric eBay ConditionID → Inventory API ConditionEnum. */
export const CONDITION_ID_TO_ENUM: Record<string, string> = {
  '1000': 'NEW',
  '1500': 'NEW_OTHER',
  '1750': 'NEW_WITH_DEFECTS',
  '2000': 'CERTIFIED_REFURBISHED',
  '2010': 'EXCELLENT_REFURBISHED',
  '2020': 'VERY_GOOD_REFURBISHED',
  '2030': 'GOOD_REFURBISHED',
  '2500': 'SELLER_REFURBISHED',
  '2750': 'LIKE_NEW',
  '3000': 'USED_EXCELLENT',
  '4000': 'USED_VERY_GOOD',
  '5000': 'USED_GOOD',
  '6000': 'USED_ACCEPTABLE',
  '7000': 'FOR_PARTS_OR_NOT_WORKING',
}

/** Enum word → numeric ConditionID (inverse of the table above + aliases some
 *  category schemas / operators legitimately use). */
export const ENUM_TO_CONDITION_ID: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(CONDITION_ID_TO_ENUM).map(([id, en]) => [en, id]),
  ),
  NEW_WITH_TAGS: '1000',
  BRAND_NEW: '1000',
  NEW_WITHOUT_TAGS: '1500',
  USED: '3000',
  PRE_OWNED: '3000',
}

/**
 * Resolve any operator-entered condition value to a Trading ConditionID.
 * Numeric values pass through; words are translated case/format-insensitively.
 * Unknown values return '' — callers surface a NAMED pre-flight error instead
 * of letting eBay answer with a generic code 37.
 */
export function toTradingConditionId(raw: string): string {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  if (/^\d+$/.test(v)) return v
  return ENUM_TO_CONDITION_ID[v.toUpperCase().replace(/[\s-]+/g, '_')] ?? ''
}
