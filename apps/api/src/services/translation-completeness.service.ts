import { resolveContentBatch, translationMissing, type ContentProduct } from './pim/content-resolver.js'
import { normalizeLanguage } from './pim/content-language.js'
import { isPresent } from './pim/resolve-channel-field.js'

// Existing command-matrix wire columns; Step 7 owns its language selector.
export type SupportedLocale = 'en' | 'de' | 'it'
export const TRANSLATION_LOCALES: SupportedLocale[] = ['en', 'de', 'it']

export function translationCoverage(product: ContentProduct, requested: string, fields: readonly string[] = ['title', 'description', 'bulletPoints', 'keywords']) {
  requested = normalizeLanguage(requested)
  const resolved = resolveContentBatch({ members: [{ product, parent: product.parent as ContentProduct }], fields, addresses: [{ requested }] })[0].fields
  const filled = Object.values(resolved).filter(value => !translationMissing(value, requested) && isPresent(value.value))
  return { hasContent: filled.length > 0, fieldCount: filled.length,
    reviewed: filled.length > 0 && filled.every(value => !value.translation || !!value.translation.reviewedAt && !value.translation.outdated) }
}
export function computeLocalePct(product: ContentProduct, locale: string): number {
  return Math.round(translationCoverage(product, locale, ['title', 'description', 'bulletPoints']).fieldCount / 3 * 100)
}
export function computeLocaleCompleteness(product: ContentProduct): Record<SupportedLocale, number> {
  return Object.fromEntries(TRANSLATION_LOCALES.map(locale => [locale, computeLocalePct(product, locale)])) as Record<SupportedLocale, number>
}
