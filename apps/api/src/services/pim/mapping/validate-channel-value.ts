import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { nativeFieldError, nativeFieldKeys, type NativeEdit } from '@nexus/shared/shopify-information'
import { coerceForShape, isBlankValue } from '../sheet-values.js'
import type { CatalogueField } from './field-catalogue.service.js'

/** Validate the effective value, including each member of a multivalued field. */
export function validateChannelValue(field: CatalogueField, input: unknown) {
  let value = input
  const errors: string[] = []
  let autoCorrected: { from: string; to: string } | null = null
  if (!isBlankValue(value) && field.selectionOnly && field.options?.length) {
    const options = [...new Set(field.options)]
    const members = Array.isArray(value) ? value : [value]
    const fixed = members.map(member => {
      const text = String(member).trim()
      const exact = options.find(option => option === text)
      if (exact !== undefined) return exact
      const codes = options.filter(option => option.toLowerCase() === text.toLowerCase())
      if (codes.length === 1) return codes[0]
      // Code spelling is locale independent (XL -> x_l even when its French
      // label is TG). Require a unique code for spelling-only matches.
      const spelling = (value: string) => value.toLowerCase().replace(/[\s_-]/g, '')
      const sameSpelling = options.filter(option => spelling(option) === spelling(text))
      if (sameSpelling.length === 1) return sameSpelling[0]
      // Otherwise accept only an unambiguous label from this actual schema.
      const labels = options.filter(option => field.optionLabels?.[option]?.trim().toLowerCase() === text.toLowerCase())
      if (labels.length === 1) return labels[0]
      return undefined
    })
    if (fixed.some(member => member === undefined)) {
      const shown = field.options.slice(0, 6).map(option => field.optionLabels?.[option] ?? option).join(' · ')
      errors.push(`${field.label} contains an unaccepted value. Allowed values: ${shown}${field.options.length > 6 ? ' …' : ''}.`)
    } else {
      const corrected = members.map((member, i) => typeof member === 'string' ? fixed[i]! : member)
      if (corrected.some((member, i) => member !== members[i])) {
        value = Array.isArray(value) ? corrected : corrected[0]
        autoCorrected = { from: JSON.stringify(input), to: JSON.stringify(value) }
      }
      for (const member of fixed) if (field.deprecatedOptions?.includes(member!)) {
        errors.push(`${field.label}: "${member}" is deprecated by the channel.`)
      }
    }
  }
  const info = field.shopifyField
  if (info) {
    const raw = value == null ? null : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
    const error = info.definition ? validateShopifyField(info.definition, raw)
      : nativeFieldKeys.includes(info.id as NativeEdit['field']) ? nativeFieldError({
        field: info.id as NativeEdit['field'], ownerId: `gid://shopify/${info.owner === 'PRODUCT' ? 'Product' : 'ProductVariant'}/1`,
        productId: 'gid://shopify/Product/1', ownerLabel: field.label, value: null, nextValue: raw,
      }) : null
    // Optional empty mappings are missing data, not an instruction to erase a required native value.
    if (error && (!isBlankValue(value) || field.priority === 'required')) errors.push(error)
  }
  // Coercion is used for validation only. Preview never converts structured records to text.
  const checked = coerceForShape({ key: field.fieldKey, label: field.label, kind: field.kind,
    shape: field.shape, cardinality: field.cardinality, unitOptions: field.unitOptions, validation: field.validation }, value)
  if (!info?.definition && checked.ok === false) errors.push(checked.error)
  const strings = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string')
  const chars = Math.max(0, ...strings.map(v => v.length))
  const bytes = Math.max(0, ...strings.map(v => Buffer.byteLength(v, 'utf8')))
  const overLimit = {
    ...(field.maxLength && chars > field.maxLength ? { chars } : {}),
    ...(field.maxBytes && bytes > field.maxBytes ? { bytes } : {}),
  }
  if (overLimit.chars) errors.push(`${field.label} exceeds ${field.maxLength} characters (${chars}).`)
  if (overLimit.bytes) errors.push(`${field.label} exceeds ${field.maxBytes} UTF-8 bytes (${bytes}).`)
  return { value, errors, autoCorrected, overLimit: Object.keys(overLimit).length ? overLimit : null }
}
