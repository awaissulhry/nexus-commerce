import { readPath } from '../pim/sheet-values.js'

export const ETSY_CONTENT_FIELDS = new Set(['title', 'description', 'tags'])
export function etsyContentState(listing: Record<string, any> | null | undefined, locale: string, field: string) {
  if (!listing || !ETSY_CONTENT_FIELDS.has(field)) return null
  locale = locale.toLowerCase()
  const attrs = listing.platformAttributes ?? {}
  const drafts = attrs._etsyInformationLocales ?? {}
  const tag = Object.keys(drafts).find(key => key.toLowerCase() === locale) ?? locale
  const draft = readPath(drafts, [Object.prototype.hasOwnProperty.call(drafts, locale) ? locale : tag, field])
  if (draft !== undefined) return { value: draft, requestedLocale: locale, effectiveLocale: locale, translationState: 'draft' as const, needsTranslation: false }
  const translations = Array.isArray(attrs.translations) ? attrs.translations : Object.values(attrs.translations ?? {})
  const translated = translations.find((row: any) => row && String(row.language).toLowerCase() === locale) as Record<string, unknown> | undefined
  if (translated && Object.prototype.hasOwnProperty.call(translated, field)) return { value: translated[field], requestedLocale: locale, effectiveLocale: locale, translationState: 'current' as const, needsTranslation: false }
  const primary = typeof attrs.language === 'string' && attrs.language ? attrs.language.toLowerCase() : null
  const value = Object.prototype.hasOwnProperty.call(attrs, field) ? attrs[field] : listing[field]
  // Unknown source language must never become a translated value by guessing.
  if (value === undefined || !primary) return null
  return { value, requestedLocale: locale, effectiveLocale: primary, translationState: primary === locale ? 'current' as const : 'fallback' as const, needsTranslation: primary !== locale }
}
