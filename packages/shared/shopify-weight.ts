/**
 * A Shopify variant weight (`InventoryItemMeasurement.weight`): a number and one of Shopify's four `WeightUnit` codes.
 * Nexus stores and sends the codes; people read the symbols (KILOGRAMS → kg). Shared products and older saved rules spell
 * the unit g / kg / oz / lb (any case): those spellings are read as the code. Only the spelling changes, never the number.
 * Re-exported by `shopify-information.ts`; its own module so `shopify-sheet.ts` can use it without an import cycle.
 */
export const SHOPIFY_WEIGHT_UNITS = ['GRAMS', 'KILOGRAMS', 'OUNCES', 'POUNDS'] as const
export type ShopifyWeightUnit = typeof SHOPIFY_WEIGHT_UNITS[number]

const SPELLINGS: Record<string, ShopifyWeightUnit> = {
  g: 'GRAMS', gr: 'GRAMS', gram: 'GRAMS', grams: 'GRAMS',
  kg: 'KILOGRAMS', kgs: 'KILOGRAMS', kilogram: 'KILOGRAMS', kilograms: 'KILOGRAMS',
  oz: 'OUNCES', ounce: 'OUNCES', ounces: 'OUNCES',
  lb: 'POUNDS', lbs: 'POUNDS', pound: 'POUNDS', pounds: 'POUNDS',
}
const SYMBOLS: Record<ShopifyWeightUnit, string> = { GRAMS: 'g', KILOGRAMS: 'kg', OUNCES: 'oz', POUNDS: 'lb' }
const GRAMS_PER_UNIT: Record<ShopifyWeightUnit, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 }

/** Any spelling of a weight unit, in any case, as Shopify's code; null for anything else (never a guess). */
export function shopifyWeightUnit(unit: unknown): ShopifyWeightUnit | null {
  return typeof unit === 'string' ? SPELLINGS[unit.trim().toLowerCase()] ?? null : null
}

/** The symbol a person reads for a weight unit (KILOGRAMS → kg); an unknown unit is shown as it is. */
export function shopifyWeightSymbol(unit: unknown): string {
  const code = shopifyWeightUnit(unit)
  return code ? SYMBOLS[code] : unit == null ? '' : String(unit)
}

function weightRecord(weight: unknown): Record<string, unknown> | null {
  let parsed = weight
  if (typeof weight === 'string') { try { parsed = JSON.parse(weight) } catch { return null } }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}

/**
 * A weight `{ value, unit }` — an object or its JSON text — with its unit as Shopify's code, in the form it came in.
 * Anything else (no unit, an unknown unit, not a weight) comes back unchanged, for the validator to name.
 */
export function normalizeShopifyWeight<T>(weight: T): T {
  const record = weightRecord(weight)
  const unit = record ? shopifyWeightUnit(record.unit) : null
  if (!record || !unit || unit === record.unit) return weight
  const next = { ...record, unit }
  return (typeof weight === 'string' ? JSON.stringify(next) : next) as T
}

/** A weight in grams (to the milligram), to compare two weights written in different units; null when it is not one. */
export function shopifyWeightGrams(weight: unknown): number | null {
  const record = weightRecord(weight)
  const unit = record ? shopifyWeightUnit(record.unit) : null
  const value = typeof record?.value === 'number' ? record.value : typeof record?.value === 'string' && record.value.trim() !== '' ? Number(record.value) : NaN
  if (!unit || !Number.isFinite(value)) return null
  return Math.round(value * GRAMS_PER_UNIT[unit] * 1000) / 1000
}
