/**
 * Smart parsers for the bulk-ops weight + dimension cells.
 *
 * The user can type "5kg", "5 kg", "5.5 lb", "5,5kg" (Italian comma),
 * or just a plain number. The parser returns the numeric value and
 * — when a unit suffix is present — the detected unit, which the
 * commit layer routes to the corresponding *Unit column.
 */

const WEIGHT_UNITS = new Set(['kg', 'g', 'lb', 'oz'])
const DIM_UNITS = new Set(['cm', 'mm', 'in'])
const DIM_UNIT_ALIASES: Record<string, string> = {
  inch: 'in',
  inches: 'in',
}

export interface ParsedNumeric {
  value: number
  /** Raw unit suffix the user typed (lowercased). undefined if they
   *  didn't include one, in which case the existing column value is
   *  retained. */
  unit?: string
}

function localeToFloat(raw: string): number {
  const trimmed = raw.trim()
  if (trimmed === '') return NaN
  // Treat "5,5" as "5.5" only when there's no period already (avoids
  // "1,000.00" → "1.000.00" — out of scope for these fields anyway,
  // but defensive).
  const normalised =
    trimmed.includes('.') || !trimmed.includes(',')
      ? trimmed
      : trimmed.replace(',', '.')
  const num = Number(normalised)
  return num
}

function parseWithUnits(
  raw: string,
  allowed: Set<string>,
  aliases: Record<string, string> = {},
): ParsedNumeric | null {
  if (raw == null) return null
  const trimmed = String(raw).trim()
  if (trimmed === '') return null
  // Match: digits + optional decimal + optional unit suffix
  const match = trimmed.toLowerCase().match(/^([0-9]+(?:[.,][0-9]+)?)\s*([a-z]+)?$/)
  if (!match) return null
  const value = localeToFloat(match[1])
  if (Number.isNaN(value) || value < 0) return null
  const rawUnit = match[2]
  if (!rawUnit) return { value }
  const unit = aliases[rawUnit] ?? rawUnit
  if (!allowed.has(unit)) return null
  return { value, unit }
}

export function parseWeight(raw: string): ParsedNumeric | null {
  return parseWithUnits(raw, WEIGHT_UNITS)
}

export function parseDimension(raw: string): ParsedNumeric | null {
  return parseWithUnits(raw, DIM_UNITS, DIM_UNIT_ALIASES)
}

export function isWeightFieldId(id: string): boolean {
  return id === 'weightValue'
}
export function isDimFieldId(id: string): boolean {
  return id === 'dimLength' || id === 'dimWidth' || id === 'dimHeight'
}
