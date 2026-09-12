import { createHash } from 'node:crypto'

/** Matches the existing translation API's configured language for native columns. */
export const PRIMARY_CONTENT_LOCALE = (process.env.NEXUS_PRIMARY_LANGUAGE ?? 'it').toLowerCase()
export const CONTENT_COLUMNS = { title: 'name', description: 'description', bulletPoints: 'bulletPoints', keywords: 'keywords' } as const
export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
type Bag = Record<string, any>
export const contentLocale = (locale: string) => locale.toLowerCase()
export interface ContentReview { state: 'draft' | 'reviewed'; sourceLocale: string; sourceHash: string; authoredAt: string }

/** Read-only compatibility: authored JSON slots win, including intentional empties.
 * Legacy translation records remain usable until explicitly migrated. */
export function contentSlots(product: Bag): Record<string, Bag> {
  const slots: Record<string, Bag> = { ...(product.localizedContent ?? {}) }
  // Language tags are case-insensitive. Keep historical keys while exposing a
  // canonical read slot; an explicitly authored lowercase slot takes precedence.
  for (const [tag, slot] of Object.entries(slots)) {
    const locale = contentLocale(tag)
    if (tag !== locale) slots[locale] = { ...slot, ...slots[locale] }
  }
  for (const translation of product.translations ?? []) {
    const locale = String(translation.language).toLowerCase()
    const slot = { ...slots[locale] }
    for (const [key, column] of Object.entries(CONTENT_COLUMNS)) {
      const value = translation[column]
      if (slot[key] !== undefined || value == null || value === '' || Array.isArray(value) && !value.length) continue
      slot[key] = value
      // Historical reviews have no source fingerprint. Preserve their content,
      // but do not certify it against the current source.
      slot._meta = { ...slot._meta, [key]: { state: 'draft', legacy: true } }
    }
    slots[locale] = slot
  }
  return slots
}

export function sourceContent(product: Bag, key: string, locale = PRIMARY_CONTENT_LOCALE): unknown {
  locale = contentLocale(locale)
  const slots = contentSlots(product)
  if (Object.prototype.hasOwnProperty.call(slots[locale] ?? {}, key)) return slots[locale][key]
  if (locale === PRIMARY_CONTENT_LOCALE) {
    const column = CONTENT_COLUMNS[key as keyof typeof CONTENT_COLUMNS]
    if (column && product[column] !== undefined) return product[column]
    if (product.categoryAttributes?.[key] !== undefined) return product.categoryAttributes[key]
  }
  return product.parent ? sourceContent(product.parent, key, locale) : null
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
  locale = contentLocale(locale)
  const review = contentSlots(product)[locale]?._meta?.[key]
  if (!review) return 'current'
  if (review.sourceLocale && review.sourceLocale !== locale && review.sourceHash !== contentHash(sourceContent(product, key, review.sourceLocale))) return 'outdated'
  return review.state === 'reviewed' ? 'reviewed' : 'draft'
}
