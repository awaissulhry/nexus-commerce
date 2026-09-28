/**
 * Which pop-up a Shopify reference field gets, and how its references become picker choices (sheet pop-up rebuild P1,
 * docs/sheet-popup-editor/PLAN-2026-09-27.md §4.3). Pure, so it is tested without a DOM.
 *
 * Shopify's bulk editor, measured 2026-09-27: an ENTRY field (metaobject reference) opens a searchable tick list with
 * each entry's swatch or icon; a PRODUCT-like field opens an ordered list with photos and a "Select products" picker.
 * A mixed or disclosure field (several entry kinds) opens the same tick list with a kind switch over it (B3c, G18).
 * Only a field whose entry kinds are not known, or a taxonomy field with no attribute (a raw id), keeps the older picker
 * (`legacy`), and says why on screen (`olderPickerReason`).
 */
import type { ShopifyFieldDefinition, ShopifyMetaobjectDefinition, ShopifyReference, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyNoun, shopifyReferenceTypes, shopifyTaxonomyCategories } from '@nexus/shared/shopify-linked-products'
import type { MediaChoice } from '@/design-system/components'

export type ReferenceUi = 'entries' | 'resources' | 'legacy'

/** The reference types whose values are entries (metaobjects) of one or more kinds. */
const MULTI_KIND_TYPES = ['mixed_reference', 'disclosure_reference']

const RESOURCE_TYPES = ['product_reference', 'variant_reference', 'collection_reference', 'page_reference', 'article_reference', 'file_reference',
  'customer_reference', 'company_reference', 'order_reference'] as const

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

/**
 * The entry kinds a mixed or disclosure field takes, in the definition's order, and only kinds this store has
 * (`shopifyReferenceTypes`: a mixed field names them; a disclosure field takes the store's `shopify--disclosure-…` kinds).
 * `null` when they are not known — no kind named, or the rule cannot be read. Nothing is guessed (B3c, G18).
 */
export function entryKinds(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'>, schema: ShopifyStoreSchema): ShopifyMetaobjectDefinition[] | null {
  let types: string[] | null
  try { types = shopifyReferenceTypes(def, schema) } catch { return null }
  if (!types) return null
  return types.flatMap(type => schema.metaobjectDefinitions.filter(d => d.type === type))
}

/** The kinds the new picker switches between: a mixed or disclosure field's kinds, an entry field's one kind, else none. */
export function pickerEntryKinds(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'>, schema: ShopifyStoreSchema): ShopifyMetaobjectDefinition[] {
  const base = baseReferenceType(def.type)
  if (MULTI_KIND_TYPES.includes(base)) return entryKinds(def, schema) ?? []
  const one = base === 'metaobject_reference' ? singleEntryType(def, schema) : null
  return one ? schema.metaobjectDefinitions.filter(d => d.type === one) : []
}

/**
 * The kind switch over the tick list: none for one kind; a segmented control for 2–4 kinds (all in view, one press —
 * the control is made for 2–4 choices); a select for more, which stays one line on a phone.
 */
export const kindSwitchFor = (count: number): 'none' | 'segments' | 'select' => count < 2 ? 'none' : count <= 4 ? 'segments' : 'select'

/**
 * Why an entry or taxonomy field keeps the older picker, in one plain sentence for the screen (Q2: never a silent picker), and
 * whether it can still pick (`blocked` = no kind to pick from). `null` for every field the new pickers serve.
 */
export function olderPickerReason(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'> & Partial<Pick<ShopifyFieldDefinition, 'ownerType' | 'namespace' | 'constraints'>>, schema: ShopifyStoreSchema): { text: string; blocked: boolean } | null {
  const base = baseReferenceType(def.type)
  if (referenceUiFor(def, schema) !== 'legacy') return null
  /* A taxonomy value on the older picker is typed as Shopify's id: say why there is no list (B2 review). */
  if (base === 'product_taxonomy_value_reference') return def.validations.some(v => v.name === 'product_taxonomy_attribute_handle')
    ? { text: 'Shopify lists these values only through a product category, and this field has none. Paste a value’s Shopify ID to choose it.', blocked: false }
    : { text: 'This field does not name its list of values. Paste a value’s Shopify ID to choose it.', blocked: false }
  if (base !== 'metaobject_reference' && !MULTI_KIND_TYPES.includes(base)) return null
  let named: string[] | null
  try { named = shopifyReferenceTypes(def, schema) } catch { return { text: 'This field’s entry kinds cannot be read. Refresh the store schema.', blocked: true } }
  if (!named) return { text: 'This field does not name its entry kinds. Choose a kind first, then an entry.', blocked: false }
  if (base === 'disclosure_reference' && !named.length) return { text: 'This store has no disclosure entry kinds. Add one in Shopify admin, then refresh the store schema.', blocked: true }
  if (!named.some(type => schema.metaobjectDefinitions.some(d => d.type === type))) return { text: 'This field’s entry kinds are no longer in the store. Refresh the store schema.', blocked: true }
  return { text: 'This field takes more than one entry kind. Choose a kind first, then an entry.', blocked: false }
}

export function referenceUiFor(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'> & Partial<Pick<ShopifyFieldDefinition, 'ownerType' | 'namespace' | 'constraints'>>, schema: ShopifyStoreSchema): ReferenceUi {
  const base = baseReferenceType(def.type)
  /* An entry field's one kind must be in the store: a kind named only by its type can be gone, and a list of it cannot
     load. That field keeps the older picker, which says why (B3 review). */
  if (base === 'metaobject_reference') { const one = singleEntryType(def, schema); return one && schema.metaobjectDefinitions.some(d => d.type === one) ? 'entries' : 'legacy' }
  /* Mixed and disclosure fields: the tick list with a kind switch, when at least one allowed kind is known (B3c, G18). */
  if (MULTI_KIND_TYPES.includes(base)) return entryKinds(def, schema)?.length ? 'entries' : 'legacy'
  /* A taxonomy value with its attribute named ("color", "pattern") picks from Shopify's list of that attribute (B2, G12).
     Shopify lists those values only through a category: a field with no category it applies to keeps the older picker,
     where a value can still be entered, instead of a list that can only say it is empty. */
  if (base === 'product_taxonomy_value_reference') return def.validations.some(v => v.name === 'product_taxonomy_attribute_handle') && shopifyTaxonomyCategories({ ownerType: def.ownerType ?? 'PRODUCT', namespace: def.namespace ?? '', constraints: def.constraints ?? null }, schema).length ? 'entries' : 'legacy'
  if ((RESOURCE_TYPES as readonly string[]).includes(base)) return 'resources'
  return 'legacy'
}

/** The chip line's prompt: "Add color", "Add press quote" — a name in capitals ("FAQ") keeps them ("Add FAQ"). */
export const addPrompt = (name: string) => `Add ${/^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name}`

/** The words for one / many of a reference field's items — the one shared list (`@nexus/shared` `shopifyNoun`). */
export const referenceNoun = (type: string) => shopifyNoun(type)

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
