/**
 * Which pop-up a Shopify reference field gets, and how its references become picker choices (sheet pop-up rebuild P1,
 * docs/sheet-popup-editor/PLAN-2026-09-27.md §4.3). Pure, so it is tested without a DOM.
 *
 * Shopify's bulk editor, measured 2026-09-27: an ENTRY field (metaobject reference) opens a searchable tick list with
 * each entry's swatch or icon; a PRODUCT-like field opens an ordered list with photos and a "Select products" picker.
 * Fields that need a type chosen first, or a raw id (taxonomy values), keep the older picker (`legacy`).
 */
import type { ShopifyFieldDefinition, ShopifyReference, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyReferenceTypes } from '@nexus/shared/shopify-linked-products'
import type { MediaChoice } from '@/design-system/components'

export type ReferenceUi = 'entries' | 'resources' | 'legacy'

const RESOURCE_TYPES = ['product_reference', 'variant_reference', 'collection_reference', 'page_reference', 'article_reference', 'file_reference',
  'customer_reference', 'company_reference', 'order_reference'] as const

const NOUNS: Record<string, { one: string; other: string }> = {
  product_reference: { one: 'product', other: 'products' },
  variant_reference: { one: 'variant', other: 'variants' },
  collection_reference: { one: 'collection', other: 'collections' },
  page_reference: { one: 'page', other: 'pages' },
  article_reference: { one: 'article', other: 'articles' },
  file_reference: { one: 'file', other: 'files' },
  customer_reference: { one: 'customer', other: 'customers' },
  company_reference: { one: 'company', other: 'companies' },
  order_reference: { one: 'order', other: 'orders' },
  metaobject_reference: { one: 'entry', other: 'entries' },
}

/** `list.product_reference` → `product_reference`. */
export const baseReferenceType = (type: string) => (type.startsWith('list.') ? type.slice(5) : type)

/**
 * The ONE entry type an entry field may hold, when its definition names exactly one. Several permitted types (or
 * none named) cannot drive one tick list, so such a field keeps the picker that asks for the type first.
 */
export function singleEntryType(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'>, schema: ShopifyStoreSchema): string | null {
  let types: string[] | null
  try { types = shopifyReferenceTypes(def, schema) } catch { return null }
  return types && types.length === 1 ? types[0] : null
}

export function referenceUiFor(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'>, schema: ShopifyStoreSchema): ReferenceUi {
  const base = baseReferenceType(def.type)
  if (base === 'metaobject_reference') return singleEntryType(def, schema) ? 'entries' : 'legacy'
  if ((RESOURCE_TYPES as readonly string[]).includes(base)) return 'resources'
  return 'legacy'
}

export const referenceNoun = (type: string) => NOUNS[baseReferenceType(type)] ?? { one: 'reference', other: 'references' }

/** The most values a list field takes (`list.max`), when its definition declares it. */
export function listMax(def: Pick<ShopifyFieldDefinition, 'validations'>): number | null {
  const raw = def.validations.find(v => v.name === 'list.max')?.value
  const n = raw == null ? NaN : Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * A reference as a picker choice: its picture or swatch, its name, its handle as the second line. Media that Shopify is
 * still processing (or failed to process) stays visible and HELD, with the reason — never silently pickable.
 */
export function referenceChoice(ref: ShopifyReference): MediaChoice {
  const pending = ref.media && ref.media.status !== 'READY'
  return {
    value: ref.id,
    label: ref.available === false ? 'Unavailable in this store' : ref.label,
    /* The handle tells two products with one title apart (a store can hold two "AIREON Jacket"s). Entries are named by
       their display name, as Shopify's lists show them: their handle is noise there. */
    detail: ref.handle && !ref.id.includes('/Metaobject/') ? `/${ref.handle}` : undefined,
    image: ref.image,
    swatch: ref.swatch ?? null,
    ...(pending ? { heldReason: `Shopify is still processing this file (${ref.media!.status.toLowerCase()})` } : {}),
    ...(ref.available === false ? { heldReason: 'It may have been deleted in Shopify' } : {}),
  }
}

/**
 * Chosen values as choices, in the field's order. A value whose name has not arrived yet shows the kind's word ("Loading
 * product…"), never its raw id; one the store does not have is marked unknown and kept until it is removed.
 */
export function chosenChoices(values: readonly string[], names: readonly ShopifyReference[], noun: { one: string }, failed: boolean): Array<MediaChoice & { unknown?: boolean }> {
  const byId = new Map(names.map(n => [n.id, n]))
  return values.map(id => {
    const ref = byId.get(id)
    if (!ref) return { value: id, label: failed ? `${noun.one[0].toUpperCase()}${noun.one.slice(1)} preview unavailable` : `Loading ${noun.one}…` }
    const choice = referenceChoice(ref)
    return ref.available === false ? { ...choice, unknown: true } : choice
  })
}
