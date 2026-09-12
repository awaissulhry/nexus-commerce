import type { ColDef } from 'ag-grid-community'

export interface ScalarColumnLike {
  kind: string
  shape?: string
  options?: string[]
  optionLabels?: Record<string, string>
}

export const BOOLEAN_OPTIONS = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]

/** Decode only declared scalar types. Unknown input stays visible for validation. */
export function parseScalarValue(col: ScalarColumnLike, raw: unknown): unknown {
  if (col.shape === 'list' || col.shape === 'measure') return raw
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') return raw
  const text = raw.trim()
  if (col.kind === 'boolean') {
    if (!text) return null
    if (['true', 'yes', 'y', '1'].includes(text.toLowerCase())) return true
    if (['false', 'no', 'n', '0'].includes(text.toLowerCase())) return false
  }
  if (col.kind === 'number') {
    if (!text) return null
    const number = Number(text.replace(',', '.'))
    return Number.isFinite(number) ? number : raw
  }
  if (col.kind === 'select') return optionCode(col, raw)
  return raw
}

/** Codes win over labels; ambiguous labels must not silently select an arbitrary option. */
export function optionCode(col: Pick<ScalarColumnLike, 'options' | 'optionLabels'>, raw: string): string {
  const text = raw.trim()
  const options = col.options ?? []
  if (options.includes(text)) return text
  const fold = text.toLowerCase()
  const labels = options.filter(code => col.optionLabels?.[code]?.trim().toLowerCase() === fold)
  if (labels.length === 1) return labels[0]
  const codes = options.filter(code => code.toLowerCase() === fold)
  return codes.length === 1 ? codes[0] : raw
}

export function booleanLabel(raw: unknown): string {
  const value = parseScalarValue({ kind: 'boolean' }, raw)
  return value === null ? '' : value === true ? 'Yes' : value === false ? 'No' : String(value)
}

/** Used by both sheet builders and by custom editors through AG's parseValue callback. */
export function scalarColumnDef<T>(col: ScalarColumnLike): Partial<ColDef<T>> {
  if (col.shape === 'list' || col.shape === 'measure') return {}
  return {
    cellDataType: false,
    valueParser: p => parseScalarValue(col, p.newValue),
    ...(col.kind === 'boolean' ? { valueFormatter: (p: { value: unknown }) => booleanLabel(p.value) } : {}),
  }
}

// Attribute schemas own numeric limits. A money editor's rounding and zero floor do not apply
// to every product fact (for example thickness, latitude, or temperature).
export const SHEET_NUMBER_EDITOR_PARAMS = { min: undefined, max: undefined, precision: undefined, step: 'any', showStepperButtons: false }
