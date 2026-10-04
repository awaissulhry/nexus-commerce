import { normalizeLanguage } from '@nexus/shared/content-language'
import { languageLabel } from '../scopes'

/** A language tag's language ("de-AT" → "de"); '' for none. Never throws on a malformed tag. */
const languageOf = (tag: string | null | undefined) => (typeof tag === 'string' ? tag.toLowerCase().split(/[-_]/, 1)[0] : '')

/**
 * The language a cell shows when it is NOT the one the sheet asks for (an eBay DE title, or the Shared product in German,
 * showing the Italian text because there is no German one): the wire's `language` and `requested` (`studio-content-wire.ts`)
 * differ. Null when the cell shows the requested language, or the wire says nothing. Both sheet scopes read it (2026-10-04).
 */
export function fallbackLanguage(cell: { language?: string | null; requested?: string | null } | null | undefined): string | null {
  const shown = languageOf(cell?.language), wanted = languageOf(cell?.requested)
  return shown && wanted && shown !== wanted ? shown : null
}

/** "the Italian text" — the language a fallback shows, by its English name, never its code. */
export const languageTextName = (language: string) => `the ${languageLabel(language)} text`

export const LANGUAGES_VIEW_ID = 'languages'
/** A view key carries a language; service field keys remain canonical. */
export function languageColumn(key: string): { fieldKey: string; locale: string | null } {
  const at = key.lastIndexOf('@')
  return at < 0 ? { fieldKey: key, locale: null } : { fieldKey: key.slice(0, at), locale: normalizeLanguage(key.slice(at + 1)) }
}
export function languageField(key: string, fallbackLocale: string): { fieldKey: string; locale: string } {
  const field = languageColumn(key)
  return { fieldKey: field.fieldKey, locale: field.locale ?? fallbackLocale }
}
/** Language-qualified column keys are also the saved view's language selection. */
export function columnLanguages(keys: readonly string[]): string[] {
  return [...new Set(keys.flatMap(key => {
    const { locale } = languageColumn(key)
    return locale ? [locale] : []
  }))]
}
export function languageSelection(value: string | null): string[] | null {
  if (value === null) return null
  try { return [...new Set(value.split(',').filter(Boolean).map(normalizeLanguage))] } catch { return [] }
}
export function toggleLanguage(selected: readonly string[], code: string, available: readonly string[]): string[] {
  const next = new Set(selected)
  if (next.has(code)) { if (next.size > 1) next.delete(code) } else next.add(code)
  return available.filter(language => next.has(language))
}

/** A pending view cannot consume the previous single-language column registry. */
export function languageProjectionReady(columns: readonly { key: string; localizable?: boolean; locale?: string }[], selected: readonly string[] | null): boolean {
  if (!columns.length) return false
  const actual = columnLanguages(columns.map(column => column.key))
  if (!selected) return actual.length === 0
  return JSON.stringify(actual) === JSON.stringify(selected) || !columns.some(column => column.localizable || column.locale)
}
