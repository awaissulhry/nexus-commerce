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
