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
  '2990': 'PRE_OWNED_EXCELLENT',
  '3000': 'USED_EXCELLENT',
  '3010': 'PRE_OWNED_FAIR',
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
 * Wave 3 (W3-4, 2026-10-05) — eBay's own English name for each condition, by numeric ConditionID. Display only: the
 * code stored and sent never changes. 1000 and 1500 take eBay's category wording (`ebayConditionName`).
 */
const CONDITION_NAME_BY_ID: Readonly<Record<string, string>> = {
  '1000': 'New',
  '1500': 'New other (see details)',
  '1750': 'New with defects',
  '2000': 'Certified - Refurbished',
  '2010': 'Excellent - Refurbished',
  '2020': 'Very Good - Refurbished',
  '2030': 'Good - Refurbished',
  '2500': 'Seller refurbished',
  '2750': 'Like New',
  '2990': 'Pre-owned - Excellent',
  '3000': 'Used',
  '3010': 'Pre-owned - Fair',
  '4000': 'Very Good',
  '5000': 'Good',
  '6000': 'Acceptable',
  '7000': 'For parts or not working',
}

/**
 * The English name of every condition code a listing can hold: the numeric ConditionID AND the Inventory enum word
 * (all 327 live eBay IT listings store `NEW`, not 1000 — production count 2026-10-05), and the enum aliases above.
 */
export const EBAY_CONDITION_NAMES: Readonly<Record<string, string>> = {
  ...CONDITION_NAME_BY_ID,
  ...Object.fromEntries(Object.entries(ENUM_TO_CONDITION_ID).map(([word, id]) => [word, CONDITION_NAME_BY_ID[id]])),
  NEW_WITH_TAGS: 'New with tags',
  NEW_WITHOUT_TAGS: 'New without tags',
}

/** eBay names 1000 / 1500 by what the category sells new: clothing "with tags", shoes "with box" (every eBay market). */
const TAGS = /\btags?\b|etichett|etikett|étiquet|etiquet/
const BOX = /\bbox\b|scatola|karton|boîte|boite|\bcaja\b/

/**
 * A condition code in eBay's English words ("NEW" → "New"; with the category's market name "Nuovo con etichette" →
 * "New with tags", Owner decision 7). A code Nexus does not know stays as it is.
 */
export function ebayConditionName(code: string, marketLabel?: string | null): string {
  const text = String(code ?? '').trim()
  const id = toTradingConditionId(text)
  if (id === '1000' || id === '1500') {
    const words = `${text} ${marketLabel ?? ''}`.toLowerCase().replace(/_/g, ' ')
    const kind = TAGS.test(words) ? 'tags' : BOX.test(words) ? 'box' : null
    if (kind) return `New ${id === '1000' ? 'with' : 'without'} ${kind}`
  }
  return CONDITION_NAME_BY_ID[id] ?? EBAY_CONDITION_NAMES[text.toUpperCase()] ?? text
}

const foldName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
/** English names typed or pasted in place of a code ("Like New", "New with box") → ConditionID. */
const CONDITION_ID_BY_NAME = new Map<string, string>([
  ...Object.entries(CONDITION_NAME_BY_ID).map(([id, name]) => [foldName(name), id] as [string, string]),
  ...['tags', 'box'].flatMap(kind => [[foldName(`New with ${kind}`), '1000'], [foldName(`New without ${kind}`), '1500']] as Array<[string, string]>),
])

/**
 * Resolve any operator-entered condition value to a Trading ConditionID.
 * Numeric values pass through; words are translated case/format-insensitively,
 * and so are eBay's English names (W3-4). Unknown values return '' — callers
 * surface a NAMED pre-flight error instead of letting eBay answer with a
 * generic code 37.
 */
export function toTradingConditionId(raw: string): string {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  if (/^\d+$/.test(v)) return v
  return ENUM_TO_CONDITION_ID[v.toUpperCase().replace(/[\s-]+/g, '_')] ?? CONDITION_ID_BY_NAME.get(foldName(v)) ?? ''
}

/** Normalize known Trading/Inventory values; preserve unknown input for validation. */
export function toInventoryCondition(raw: string): string {
  const value = String(raw ?? '').trim()
  return CONDITION_ID_TO_ENUM[toTradingConditionId(value)] ?? value
}

/**
 * Owner 2026-10-04 — a blank condition is never sent as "New". The Inventory model replaces a whole inventory item, so a
 * SKU with no condition of its own and none on the listing's main row is refused by name, before anything reaches eBay.
 */
export const EBAY_CONDITION_NOT_GUESSED = 'Condition is empty on this listing\'s main row; Nexus does not guess one.'
