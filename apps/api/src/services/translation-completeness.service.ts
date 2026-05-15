// Compute per-locale translation completion % for a product.
// Required fields: name, description, bulletPoints (≥1 item).
// Variants inherit from their master so they always return null (show '--').

export type SupportedLocale = 'en' | 'de' | 'it'

export const TRANSLATION_LOCALES: SupportedLocale[] = ['en', 'de', 'it']

interface TranslationRow {
  language: string
  name?: string | null
  description?: string | null
  bulletPoints?: string[]
}

export function computeLocalePct(
  translations: TranslationRow[],
  locale: SupportedLocale,
): number {
  const t = translations.find((x) => x.language === locale)
  if (!t) return 0
  let filled = 0
  if (t.name?.trim()) filled++
  if (t.description?.trim()) filled++
  if (t.bulletPoints && t.bulletPoints.length > 0) filled++
  return Math.round((filled / 3) * 100)
}

export function computeLocaleCompleteness(
  translations: TranslationRow[],
): Record<SupportedLocale, number> {
  return {
    en: computeLocalePct(translations, 'en'),
    de: computeLocalePct(translations, 'de'),
    it: computeLocalePct(translations, 'it'),
  }
}
