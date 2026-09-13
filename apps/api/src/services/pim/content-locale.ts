import { createHash } from 'node:crypto'
import { normalizeLanguage } from './content-language.js'
import { resolveContent } from './content-resolver.js'
import { contentLanguages, contentKeys } from './content-read.js'

/** Matches the existing translation API's configured language for native columns. */
export const PRIMARY_CONTENT_LOCALE = normalizeLanguage(process.env.NEXUS_PRIMARY_LANGUAGE ?? 'it')
export const CONTENT_COLUMNS = { title: 'name', description: 'description', bulletPoints: 'bulletPoints', keywords: 'keywords' } as const
export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
type Bag = Record<string, any>
export const contentLocale = normalizeLanguage
export interface ContentReview { state: 'draft' | 'reviewed'; sourceLocale: string; sourceHash: string; authoredAt: string }

/** Compatibility projection only; all values come from the one resolver, never legacy JSON. */
export function contentSlots(product: Bag): Record<string, Bag> {
  const fields = contentKeys(product, product.parent)
  return Object.fromEntries(contentLanguages(product, product.parent).map(language => [language,
    Object.fromEntries(fields.map(field => [field, sourceContent(product, field, language)]))]))
}

export function sourceContent(product: Bag, key: string, locale = PRIMARY_CONTENT_LOCALE): unknown {
  return resolveContent({ product: product as any, parent: product.parent, field: key, localizableKeys: [key], address: { requested: normalizeLanguage(locale) } }).value
}

/** Snapshot source text on authoring/review. Future reads compare it, so even
 * source changes made by another write path cannot leave a translation current. */
export function stampContentReview(product: Bag, merged: Record<string, Bag>, patch: Record<string, unknown>, state: 'draft' | 'reviewed' = 'draft'): Record<string, Bag> {
  const next = { ...merged }
  const sourceLocale = PRIMARY_CONTENT_LOCALE
  for (const [locale, raw] of Object.entries(patch)) {
    if (!next[locale] || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const slot = { ...next[locale], _meta: { ...next[locale]._meta } }
    for (const field of Object.keys(raw)) {
      if (field.startsWith('_')) continue
      const key = field.replace(/\[\d+\]$/, '')
      slot._meta[key] = { state, sourceLocale, sourceHash: contentHash(sourceContent({ ...product, localizedContent: merged }, key, sourceLocale)), authoredAt: new Date().toISOString() } satisfies ContentReview
    }
    next[locale] = slot
  }
  return next
}

export function contentReviewState(product: Bag, key: string, locale: string): 'current' | 'draft' | 'reviewed' | 'outdated' {
  const resolved = resolveContent({ product: product as any, parent: product.parent, field: key, localizableKeys: [key], address: { requested: normalizeLanguage(locale) } })
  if (resolved.translation?.outdated) return 'outdated'
  if (resolved.translation?.reviewedAt) return 'reviewed'
  return resolved.translation && resolved.translation.source !== 'manual' ? 'draft' : 'current'
}
