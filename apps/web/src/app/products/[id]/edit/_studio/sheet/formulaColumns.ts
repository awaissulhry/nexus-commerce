import type { FormulaCandidate } from '@/design-system/grid/editors/formulaEditing'
import { languageColumn, languageField } from './languages'

/** Formula references name canonical fields in the edited cell's language. */
export function formulaColumns<T extends { key: string }>(columns: readonly T[], fieldKey: string | undefined, fallbackLocale: string): T[] {
  const language = languageField(fieldKey ?? '', fallbackLocale).locale
  return columns.filter(column => {
    const locale = languageColumn(column.key).locale
    return !locale || locale === language
  })
}

export function formulaCandidates(columns: readonly { key: string; label: string }[], values: Readonly<Record<string, { value?: unknown } | undefined>>, fieldKey: string | undefined, fallbackLocale: string): FormulaCandidate[] {
  return formulaColumns(columns, fieldKey, fallbackLocale).map(column => {
    const value = values[column.key]?.value
    return { name: languageColumn(column.key).fieldKey, kind: 'field', label: column.label, group: 'Columns',
      value: value == null || value === '' ? undefined : String(value) }
  })
}

export function formulaColumnId(columns: readonly { key: string }[], name: string, fieldKey: string | undefined, fallbackLocale: string): string | null {
  return formulaColumns(columns, fieldKey, fallbackLocale).find(column => languageColumn(column.key).fieldKey.toLowerCase() === name.toLowerCase())?.key ?? null
}

/** A non-text formula is read once; language formulas map back onto their exact view cells. */
export function formulaReadKey(keys: readonly string[], fieldKey: string, locale: string, fallbackLocale: string): string | null {
  if (keys.includes(`${fieldKey}@${locale}`)) return `${fieldKey}@${locale}`
  return locale === fallbackLocale && (!keys.length || keys.includes(fieldKey)) ? fieldKey : null
}
