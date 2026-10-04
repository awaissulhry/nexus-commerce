import { shopifyJson } from '@nexus/shared/shopify-linked-products'
import { informationDraftFieldError } from '@nexus/shared/shopify-information-editing'
import { nativeFieldValueError, shopifyWeightSymbol, type InformationField, type NativeEdit } from '@nexus/shared/shopify-information'

/** The sheet's draft check; native content capability comes from its actual write route. */
export function informationDraftCellError(field: InformationField, value: string | null, baseline: string | null, hasContentAddress: boolean): string | null {
  if (field.id === 'title' && hasContentAddress && (value === null || value.length <= 60000 && !value.trim() && !/[\r\n]/.test(value))) return null
  return field.definition ? informationDraftFieldError(field.definition, value) : nativeFieldValueError(field.id as NativeEdit['field'], value, baseline)
}

/** Human-readable summaries never replace the underlying structured wire value. */
export function informationValueLabel(type: string, raw: string | null | undefined): string {
  if (raw === undefined) return 'Unavailable'
  if (raw === null) return 'Not set'
  if (raw === '') return 'Empty'
  try {
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

export { informationRestriction, applyInformationCells, type InformationCellChange } from '@nexus/shared/shopify-information-editing'
export { acceptsTextTransfer } from './informationTransfer'

export function editTags(original: string | null, text: string, operation: 'replace' | 'add' | 'remove'): string {
  const base: unknown = original === null ? [] : JSON.parse(original)
  if (!Array.isArray(base) || base.some(item => typeof item !== 'string')) throw new Error('The stored tag list needs review before editing.')
  const items = [...new Set(text.split(/\r?\n/).map(item => item.trim()).filter(Boolean))]
  return JSON.stringify(operation === 'replace' ? items : operation === 'add' ? [...new Set([...base, ...items])] : base.filter(item => !items.includes(item)))
}
