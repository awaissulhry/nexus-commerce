/**
 * The handle of a new reusable entry (Lane B slice B2): readable like Shopify admin's ("water-repellent"), made from the
 * entry's display field, plus a short suffix fixed for one editor so a retried save finds its own entry and never makes a
 * second one. Pure; tested in `entryHandle.vitest.test.ts`.
 */
import type { ShopifyMetaobjectDefinition } from '@nexus/shared/shopify-linked-products'

export const ENTRY_HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/
const DISPLAY_KEYS = ['label', 'heading', 'title', 'name', 'question', 'quote', 'text']

/** The field an entry is known by: a usual name key, else the first one-line text field. */
export function entryDisplayKey(definition: Pick<ShopifyMetaobjectDefinition, 'fields'>): string | undefined {
  return DISPLAY_KEYS.find(key => definition.fields.some(f => f.key === key && f.type === 'single_line_text_field'))
    ?? definition.fields.find(f => f.type === 'single_line_text_field')?.key
}

/** "Water-repellent fabric!" + "k2p9" → "water-repellent-fabric-k2p9"; nothing typed yet → "entry-k2p9". */
export function entryHandle(display: string | null | undefined, suffix: string): string {
  const slug = (display ?? '').replace(/ß/g, 'ss').replace(/æ/gi, 'ae').replace(/ø/gi, 'o').replace(/œ/gi, 'oe').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return `${slug || 'entry'}-${suffix}`
}
