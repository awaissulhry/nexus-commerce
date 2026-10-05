import { shopifyJson } from '@nexus/shared/shopify-linked-products'
import { informationDraftFieldError } from '@nexus/shared/shopify-information-editing'
import { nativeFieldValueError, shopifyInventoryPolicyLabel, shopifyStatusLabel, shopifyUnitPriceLabel, shopifyWeightSymbol, type InformationField, type NativeEdit } from '@nexus/shared/shopify-information'

/** The sheet's draft check; native content capability comes from its actual write route. */
export function informationDraftCellError(field: InformationField, value: string | null, baseline: string | null, hasContentAddress: boolean): string | null {
  if (field.id === 'title' && hasContentAddress && (value === null || value.length <= 60000 && !value.trim() && !/[\r\n]/.test(value))) return null
  return field.definition ? informationDraftFieldError(field.definition, value) : nativeFieldValueError(field.id as NativeEdit['field'], value, baseline)
}

/**
 * Human-readable summaries never replace the underlying structured wire value. `names` (W3-4): the column's names for
 * the ids it holds — the store's sales channels, the synced Shopify taxonomy's categories; an id without one stays.
 */
export function informationValueLabel(type: string, raw: string | null | undefined, names?: Readonly<Record<string, string>> | null): string {
  if (raw === undefined) return 'Unavailable'
  if (raw === null) return 'Not set'
  if (raw === '') return 'Empty'
  // Shopify status (D4): Title Case words; the stored value stays Shopify's code (ACTIVE reads "Active").
  if (type === 'status') return shopifyStatusLabel(raw)
  // W3-4 (Owner decision 10): "Continue selling when out of stock" reads Yes / No; the value stays CONTINUE / DENY.
  if (type === 'inventory_policy') return shopifyInventoryPolicyLabel(raw)
  if (type === 'category') return names?.[raw] ?? raw
  try {
    if (type === 'publication') return salesChannelsLabel(shopifyJson.parse(raw), names)
    if (type.startsWith('list.') && !type.includes('_reference')) {
      const values = shopifyJson.parse(raw)
      return values.length ? values.map((value: unknown) => informationValueLabel(type.slice(5), typeof value === 'string' ? value : shopifyJson.stringify(value))).join(', ') : 'Empty list'
    }
    if (type === 'rich_text_field') {
      const text = (node: any): string => node?.type === 'text' ? node.value ?? '' : (node?.children ?? []).map(text).join(node?.type === 'root' ? ' · ' : '')
      return text(shopifyJson.parse(raw)) || 'Empty content'
    }
    if (raw.startsWith('{')) {
      const value = shopifyJson.parse(raw)
      // W3-4 — a unit price reads "200 ml, priced per 1 L"; the value stays Shopify's record and unit codes.
      if (type === 'measurement' && (value.quantityUnit !== undefined || value.referenceUnit !== undefined)) return shopifyUnitPriceLabel(value)
      // A weight reads as its symbol (Shopify stores KILOGRAMS: "1.2 kg"); other units as Shopify names them.
      if (value.unit !== undefined && value.value !== undefined) return type === 'weight' ? `${value.value} ${shopifyWeightSymbol(value.unit)}` : `${value.value} ${String(value.unit).replace(/_/g, ' ')}`
      if (type === 'money') return `${value.amount} ${value.currency_code}`
      if (type === 'rating') return `${value.value} / ${value.scale_max}`
      if (type === 'link') return value.text
      if (type === 'json') return `${Object.keys(value).length} properties`
    }
  } catch { return 'Stored value needs review' }
  return raw
}

/**
 * W3-4 — a product's sales channels by name ("Online Store, Point of Sale"), from the store's publications. An id the
 * store does not list is "Unknown sales channel"; without the store's names the count is said instead.
 */
function salesChannelsLabel(entries: unknown, names?: Readonly<Record<string, string>> | null): string {
  if (!Array.isArray(entries)) return 'Stored value needs review'
  if (!entries.length) return 'No sales channels'
  if (!names) return `${entries.length} sales ${entries.length === 1 ? 'channel' : 'channels'}`
  const ids = entries.map(entry => entry && typeof entry === 'object' ? (entry as { publicationId?: unknown }).publicationId : undefined)
  const known = ids.flatMap(id => typeof id === 'string' && names[id] ? [names[id]] : [])
  const unknown = ids.length - known.length
  return [...known, ...(unknown ? [unknown === 1 ? 'Unknown sales channel' : `${unknown} unknown sales channels`] : [])].join(', ')
}

export { informationRestriction, applyInformationCells, type InformationCellChange } from '@nexus/shared/shopify-information-editing'
export { acceptsTextTransfer } from './informationTransfer'

export function editTags(original: string | null, text: string, operation: 'replace' | 'add' | 'remove'): string {
  const base: unknown = original === null ? [] : JSON.parse(original)
  if (!Array.isArray(base) || base.some(item => typeof item !== 'string')) throw new Error('The stored tag list needs review before editing.')
  const items = [...new Set(text.split(/\r?\n/).map(item => item.trim()).filter(Boolean))]
  return JSON.stringify(operation === 'replace' ? items : operation === 'add' ? [...new Set([...base, ...items])] : base.filter(item => !items.includes(item)))
}
