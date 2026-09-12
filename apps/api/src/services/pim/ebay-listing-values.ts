import { toInventoryCondition } from '../ebay-condition.js'

/** Legacy Trading values and current Inventory values describe the same listing setting. */
export function normalizeEbayListingValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (key === 'conditionId') return toInventoryCondition(String(value))
  if (typeof value !== 'string') return value
  if (key === 'dimensionUnit' && /^(CENTIMETER|METER|INCH|FEET)$/i.test(value)) return value.toUpperCase()
  if (key === 'dimensionUnit') return ({ CM: 'CENTIMETER', M: 'METER', IN: 'INCH', FT: 'FEET', CENTIMETERS: 'CENTIMETER', METERS: 'METER', INCHES: 'INCH' } as Record<string, string>)[value.toUpperCase()] ?? value
  if (key === 'listingFormat') return ({ FixedPriceItem: 'FIXED_PRICE', Chinese: 'AUCTION' } as Record<string, string>)[value] ?? value
  if (key === 'listingDuration' && /^(?:Days_\d+|GTC)$/i.test(value)) return value.toUpperCase()
  return value
}
