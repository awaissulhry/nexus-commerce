/** Existing writer compatibility only. No read endpoint may import this; retired with Step 4 writers. */
import { CONTENT_COLUMNS } from './content-locale.js'
const contentLocale = (tag: string) => tag.toLowerCase()
type Bag = Record<string, any>
export function legacyContentSlotsForWrite(product: Bag): Record<string, Bag> {
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

