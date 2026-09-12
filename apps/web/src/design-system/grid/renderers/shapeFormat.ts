/**
 * GDS — the two non-scalar cell SHAPES (AM.1 §A.3 rows 3–4, Owner-approved 2026-09-05), as pure rules.
 *
 * A `shape: 'list'` cell holds `string[]` (an unbounded or >10-member list — `recommended_browse_nodes`,
 * `supplier_declared_dg_hz_regulation`, eBay MULTI aspects); a `shape: 'measure'` cell holds
 * `{ value, unit }` (`item_weight`, eBay `packageWeight`). Before this module the sheet stringified
 * both (measured 2026-09-05: the list cell showed its first element and opened a SINGLE-select
 * listbox, so a pick would have written one string over an array).
 *
 * Everything here is what both column builders and both renderers call, so the two scopes cannot
 * read the same array two ways. Pure `.ts`, node-tested; the React cells and the popup editors that
 * use these rules live in `shapeCells.tsx` and `editors/ListPanelEditor.tsx` / `MeasureEditor.tsx`.
 */
import type { SheetValidation } from '../editors/sheet'

export type CellShape = 'scalar' | 'list' | 'measure'

export interface MeasureValue {
  value: number | null
  unit: string | null
}

/** The column fields the shape rules read — a subset of both sheets' `SheetColumn` mirrors. */
export interface ShapeColumnLike {
  shape?: CellShape
  /** list only; `max: null` = unbounded */
  cardinality?: { min: number; max: number | null }
  /** measure only: the channel's closed unit list */
  unitOptions?: string[]
  /** list: the per-ITEM character cap */
  maxLength?: number | null
  capFrom?: string | null
  requiredBy: string[]
  /** closed list: code → the channel's label (#669 — the cell shows what the dropdown offered) */
  optionLabels?: Record<string, string>
}

/** The label a closed-list item shows; a code with no label shows as itself, never blank. */
export function listLabelOf(col: { optionLabels?: Record<string, string> }): (item: string) => string {
  return (item) => col.optionLabels?.[item] ?? item
}

/**
 * The cell reads `1.2 kg`, never `1.2 kilograms` (§A.3). Channels spell units as words in their
 * enums (Amazon `kilograms`, eBay `KILOGRAM`); the cell shows the symbol and the tooltip keeps the
 * word. Unknown units fall back to the word as given — an invented symbol would be a fabricated fact.
 */
const UNIT_SYMBOLS: Record<string, string> = {
  kilogram: 'kg', kilograms: 'kg', gram: 'g', grams: 'g', milligram: 'mg', milligrams: 'mg',
  pound: 'lb', pounds: 'lb', ounce: 'oz', ounces: 'oz', ton: 't', tons: 't', tonne: 't', tonnes: 't',
  centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
  meter: 'm', meters: 'm', metre: 'm', metres: 'm', inch: 'in', inches: 'in', foot: 'ft', feet: 'ft',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  watt: 'W', watts: 'W', volt: 'V', volts: 'V', ampere: 'A', amperes: 'A',
  hour: 'h', hours: 'h', day: 'd', days: 'd', week: 'wk', weeks: 'wk', month: 'mo', months: 'mo', year: 'yr', years: 'yr',
}

export function unitSymbol(unit: string | null | undefined): string {
  if (unit == null || unit === '') return ''
  return UNIT_SYMBOLS[String(unit).trim().toLowerCase()] ?? String(unit)
}

/** The list a cell holds. A legacy scalar reads as a one-item list (read-compat, never written back as such). */
export function asList(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x).trim())).filter((s) => s !== '')
  if (typeof v === 'string') {
    const s = v.trim()
    return s ? [s] : []
  }
  return [String(v)]
}

export function isMeasure(v: unknown): v is MeasureValue {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object) && 'unit' in (v as object)
}

/** The measure a cell holds. A bare number is a value without a unit; `"1.2 kg"` parses (read-compat). */
export function asMeasure(v: unknown): MeasureValue {
  if (isMeasure(v)) {
    const n = v.value as unknown
    const value =
      typeof n === 'number' && Number.isFinite(n) ? n
      : typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n.replace(',', '.'))) ? Number(n.replace(',', '.'))
      : null
    const unit = v.unit == null || v.unit === '' ? null : String(v.unit)
    return { value, unit }
  }
  if (typeof v === 'number') return { value: Number.isFinite(v) ? v : null, unit: null }
  if (typeof v === 'string') {
    const m = v.trim().match(/^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?)\s*(.*?)$/)
    if (m && Number.isFinite(Number(m[1].replace(',', '.')))) return { value: Number(m[1].replace(',', '.')), unit: m[2] || null }
  }
  return { value: null, unit: null }
}

/**
 * 🔴 `shape` is NEVER tested for truthiness: the contract sets `shape: 'scalar'` EXPLICITLY on every ordinary
 * column (169 of 192 on master), so `!col.shape` is false for a plain select — measured 2026-09-05 as every
 * channel select losing its class and chevron. Ask this, not `!shape`.
 */
export function isShaped(col: { shape?: string | null } | null | undefined): boolean {
  return col?.shape === 'list' || col?.shape === 'measure'
}

export function isEmptyShape(shape: CellShape | undefined, v: unknown): boolean {
  if (shape === 'list') return asList(v).length === 0
  if (shape === 'measure') {
    const m = asMeasure(v)
    return m.value === null && m.unit === null
  }
  return v == null || v === ''
}

const formatNumber = (n: number): string => String(n)

export function formatMeasure(v: unknown): string {
  const m = asMeasure(v)
  if (m.value === null && m.unit === null) return ''
  if (m.value === null) return unitSymbol(m.unit)
  const num = formatNumber(m.value)
  return m.unit ? `${num} ${unitSymbol(m.unit)}` : num
}

/** The on-screen separator. Visible — `reference_composed_string_invisible_separator`: a bare space or `\n` collapses. */
export const LIST_SEPARATOR = ' · '

export function formatList(v: unknown, sep: string = LIST_SEPARATOR): string {
  return asList(v).join(sep)
}

/** "count + first values" for the chip cell (§A.3): the first `shown` items and how many more there are. */
export function listSummary(v: unknown, shown = 2): { shown: string[]; more: number; total: number } {
  const items = asList(v)
  return { shown: items.slice(0, shown), more: Math.max(0, items.length - shown), total: items.length }
}

/** The tooltip's line for a shaped cell — the FULL list, or the measure with its unit spelled out. */
export function shapeTooltipLine(col: ShapeColumnLike, v: unknown): string | undefined {
  if (col.shape === 'list') {
    const items = asList(v)
    if (items.length === 0) return undefined
    const cap = col.cardinality?.max
    const from = col.capFrom ? ` (${col.capFrom})` : ''
    return `${items.length} ${items.length === 1 ? 'value' : 'values'}${cap != null ? ` of up to ${cap}${from}` : ''}: ${items.map(listLabelOf(col)).join(LIST_SEPARATOR)}`
  }
  if (col.shape === 'measure') {
    const m = asMeasure(v)
    if (m.value === null && m.unit === null) return undefined
    const units = col.unitOptions?.length ? ` · units: ${col.unitOptions.join(', ')}` : ''
    return `${m.value ?? '—'} ${m.unit ?? '(no unit)'}${units}`
  }
  return undefined
}

/**
 * Readiness per shape (§A.3): a list is required ⇒ at least `max(min, 1)` values, never more than
 * `max`, no item over the per-item cap; a measure is complete only with BOTH a value and a unit, and
 * warns on a unit the channel does not list. Messages follow `lengthValidation`'s form
 * (`n of cap …`) and carry `capFrom` (§9.3a: a cap must name whose cap it is).
 */
export function shapeValidation<T>(col: ShapeColumnLike, required: boolean): SheetValidation<T> {
  const from = col.capFrom ? ` — ${col.capFrom}` : ''
  if (col.shape === 'list') {
    return {
      validate: (v) => {
        const items = asList(v)
        if (items.length === 0) return required ? { level: 'error', message: 'Required' } : { level: null }
        const min = Math.max(col.cardinality?.min ?? 0, required ? 1 : 0)
        if (items.length < min) return { level: 'error', message: `${items.length} of at least ${min} values${from}` }
        const max = col.cardinality?.max
        if (max != null && items.length > max) return { level: 'error', message: `${items.length} of ${max} values${from}` }
        if (col.maxLength) {
          const longest = Math.max(...items.map((s) => s.length))
          if (longest > col.maxLength) return { level: 'error', message: `${longest} of ${col.maxLength} characters in one value${from}` }
        }
        return { level: null }
      },
    }
  }
  if (col.shape === 'measure') {
    return {
      validate: (v) => {
        const m = asMeasure(v)
        if (m.value === null && m.unit === null) return required ? { level: 'error', message: 'Required' } : { level: null }
        if (m.value === null) return { level: 'error', message: `A unit without a value${from}` }
        if (m.unit === null) return { level: 'error', message: `${formatNumber(m.value)} without a unit${from}` }
        if (col.unitOptions?.length && !col.unitOptions.some((u) => u.toLowerCase() === m.unit!.toLowerCase())) {
          return { level: 'warn', message: `"${m.unit}" is not one of the channel's units (${col.unitOptions.join(', ')})` }
        }
        return { level: null }
      },
    }
  }
  return { validate: () => ({ level: null }) }
}
