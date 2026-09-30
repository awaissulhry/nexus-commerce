import { asMeasure, unitSymbol, type CellShape } from '../renderers/shapeFormat'
import { isFormulaDraft } from './formulaEditing'
import { optionCode } from './scalarValue'

/** Decode displayed labels using this column's schema; preserve unparseable input for refusal. */
export function parseShape(shape: CellShape | undefined, raw: unknown, col: {
  options?: string[]; optionLabels?: Record<string, string>; unitOptions?: string[]
} = {}): unknown {
  if (raw == null || raw === '') return null
  if (typeof raw === 'string' && isFormulaDraft(raw)) return raw
  if (shape === 'list') {
    const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\s*[|·]\s*|\r?\n/) : null
    if (!items || items.some(v => v !== null && typeof v === 'object')) return raw
    return items.filter(v => v != null && String(v).trim() !== '').map(v => optionCode(col, String(v)))
  }
  if (shape === 'measure') {
    // A typed editor already supplies the record. Do not turn an invalid member into null.
    if (typeof raw === 'object') return raw
    const measure = asMeasure(raw)
    if (measure.value === null && measure.unit === null) return String(raw).trim() === '' ? null : raw
    if (measure.unit && !col.unitOptions?.includes(measure.unit)) {
      const matches = (col.unitOptions ?? []).filter(unit => unitSymbol(unit) === measure.unit || unit.toLowerCase() === measure.unit!.toLowerCase())
      if (matches.length === 1) measure.unit = matches[0]
    }
    return measure
  }
  return raw
}

/** The measure editor's value while the operator types: a number, or the typed text the server will refuse. */
export type MeasureDraft = { value: number | string | null; unit: string | null }

/**
 * The measure editor's number field, read as a paste reads the same text (`parseShape`): "1.5 kg", "12kg" and "9 OUNCE"
 * carry their unit, a bare number keeps the chosen one. Text that is still not a number is reported as typed, so the
 * server refuses it by name ("… is not a number"). It used to be reported as `value: null`, which saved as an empty weight
 * with no warning (audit B08, 2026-09-30).
 */
export function measureFromText(text: string, unit: string | null, unitOptions: string[]): MeasureDraft {
  const typed = text.trim()
  if (typed === '') return { value: null, unit }
  const parsed = parseShape('measure', typed, { unitOptions })
  if (parsed && typeof parsed === 'object' && typeof (parsed as MeasureDraft).value === 'number') {
    const m = parsed as MeasureDraft
    return { value: m.value, unit: m.unit ?? unit }
  }
  return { value: typed, unit }
}
