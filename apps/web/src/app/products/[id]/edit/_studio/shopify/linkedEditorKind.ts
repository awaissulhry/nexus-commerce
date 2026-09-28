/**
 * Which editor a Shopify metafield opens in the cell pop-up (Lane B slice B1, docs/shopify-metafields/PLAN-2026-09-28.md
 * §6, §7 L2). Moved out of `LinkedFieldEditor.tsx` so every type's choice is tested without a DOM; the editor renders what
 * this returns and nothing else decides.
 */
import type { ShopifyFieldDefinition, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyJson, shopifyObjectType, validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { referenceUiFor } from './referenceFieldModel'

export type LinkedEditorKind =
  /** Entry tick list with swatches / icons (an entry field; a mixed or disclosure field with a kind switch, B3c). */
  | 'entries'
  /** Ordered list with photos + a picker dialog (products, pages, files, …). */
  | 'resources'
  /** The older picker that asks for a type first: an entry field whose kinds are not known (with its reason on screen), a
   *  taxonomy value field with no attribute (a raw id). */
  | 'older-picker'
  /** A list of plain values: one editor per value, "Add value". */
  | 'list'
  /** A stored list that does not parse: a repair box. */
  | 'broken-list'
  /** Stars and a number inside the store's fixed scale. */
  | 'rating'
  /** Number + unit, amount + currency, text + link. */
  | 'compound'
  | 'rich-text'
  | 'yes-no'
  | 'choices'
  | 'date'
  | 'colour'
  /** One line of text, a number, a web address, a code. */
  | 'line'
  /** A multi-line box: Enter adds a line, Ctrl/⌘+Enter saves. */
  | 'multi-line'
  /** Any other text box (JSON, jurisdiction, a broken reference list). */
  | 'box'

const LINE_TYPES = ['single_line_text_field', 'number_integer', 'number_decimal', 'url', 'date', 'date_time', 'id', 'language']

export function linkedEditorKind(def: ShopifyFieldDefinition, value: string | null, schema: ShopifyStoreSchema): LinkedEditorKind {
  const list = def.type.startsWith('list.'), type = list ? def.type.slice(5) : def.type, reference = type.endsWith('_reference')
  if (reference) {
    let values: unknown = value === null ? [] : list ? null : [value]
    if (list && value !== null) { try { values = JSON.parse(value) } catch { values = null } }
    const valid = Array.isArray(values) && values.every(v => typeof v === 'string') && new Set(values).size === values.length
    if (!valid) return 'box'
    const ui = referenceUiFor(def, schema)
    return ui === 'legacy' ? 'older-picker' : ui
  }
  if (list) {
    let items: unknown
    try { items = value === null ? [] : shopifyJson.parse(value) } catch { items = null }
    return Array.isArray(items) ? 'list' : 'broken-list'
  }
  if (type === 'rating' && def.validations.some(v => v.name === 'scale_min') && def.validations.some(v => v.name === 'scale_max')) return 'rating'
  if (shopifyObjectType(type)) return 'compound'
  if (type === 'rich_text_field') return 'rich-text'
  if (type === 'boolean') return 'yes-no'
  let choices = false
  try { const parsed = JSON.parse(def.validations.find(v => v.name === 'choices')?.value ?? 'null'); choices = Array.isArray(parsed) && parsed.every(v => typeof v === 'string') } catch { choices = false }
  if (choices) return 'choices'
  if (type === 'date' && !validateShopifyField(def, value)) return 'date'
  if (type === 'color') return 'colour'
  if (LINE_TYPES.includes(type)) return 'line'
  if (type === 'multi_line_text_field') return 'multi-line'
  return 'box'
}
