import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { nativeFieldError, nativeFieldKeys, normalizeShopifyWeight, type NativeEdit } from '@nexus/shared/shopify-information'
import { checkForStorage, isBlankValue } from '../sheet-values.js'
import { finding, type ValueFinding } from '../value-verdict.js'
import { ebayAspectValues } from '../../ebay-aspect-values.js'
import type { CatalogueField } from './field-catalogue.service.js'

/**
 * P6 (docs/attributes/PLAN.md §4.4) — "this value is not on the channel's closed list", whichever validator said it:
 * `validateChannelValue` below, Ajv's `enum` keyword (schema-requirements.ts), or a Shopify `choices` rule
 * (`validateShopifyField`). Such a finding is a FLAG (readiness, preview, a held publish), never a refusal to save.
 * Pinned against each validator's real output in `off-list-error.vitest.test.ts`.
 */
const OFF_LIST_ERROR = /contains an unaccepted value\. Allowed values:|must be equal to one of the allowed values|Choose one of these values: /
export function isOffListError(message: string): boolean {
  return OFF_LIST_ERROR.test(message)
}

/**
 * Validate the effective value, including each member of a multivalued field. Every problem is a FINDING with its rule
 * (`value-verdict.ts`); `errors` keeps the sentences, in the same order, for every reader of the old shape.
 */
export function validateChannelValue(field: CatalogueField, input: unknown) {
  let value = input
  const findings: ValueFinding[] = []
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
      findings.push(finding('offList', `${field.label} contains an unaccepted value. Allowed values: ${shown}${field.options.length > 6 ? ' …' : ''}.`))
    } else {
      const corrected = members.map((member, i) => typeof member === 'string' ? fixed[i]! : member)
      if (corrected.some((member, i) => member !== members[i])) {
        value = Array.isArray(value) ? corrected : corrected[0]
        autoCorrected = { from: JSON.stringify(input), to: JSON.stringify(value) }
      }
      for (const member of fixed) if (field.deprecatedOptions?.includes(member!)) {
        findings.push(finding('deprecated', `${field.label}: "${member}" is deprecated by the channel.`))
      }
    }
  }
  const info = field.shopifyField
  // S1 item 6 — a Shopify variant weight is held in Shopify's unit codes. A value spelled the older way (a saved rule's
  // `measure(…, "g|kg|oz|lb")`, a pasted `kg`) is read as the code; the number never changes. Only this native field.
  if (info && !info.definition && info.id === 'weight') value = normalizeShopifyWeight(value)
  if (info) {
    const raw = value == null ? null : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
    const error = info.definition ? validateShopifyField(info.definition, raw)
      : nativeFieldKeys.includes(info.id as NativeEdit['field']) ? nativeFieldError({
        field: info.id as NativeEdit['field'], ownerId: `gid://shopify/${info.owner === 'PRODUCT' ? 'Product' : 'ProductVariant'}/1`,
        productId: 'gid://shopify/Product/1', ownerLabel: field.label, value: null, nextValue: raw,
      }) : null
    // Optional empty mappings are missing data, not an instruction to erase a required native value.
    if (error && (!isBlankValue(value) || field.priority === 'required')) findings.push(finding(isOffListError(error) ? 'offList' : 'schema', error))
  }
  // Coercion is used for validation only. Preview never converts structured records to text.
  // A single-value field holding a stored LIST (a legacy `["x"]`) sends its one member; two or more is a count problem
  // the channel refuses, not a value the store cannot hold.
  const single = (field.shape ?? 'scalar') === 'scalar' && Array.isArray(value)
  const members = single ? (value as unknown[]).filter(member => !isBlankValue(member)) : []
  if (single && members.length > 1) findings.push(finding('count', `${field.label} takes one value; ${members.length} are set.`))
  const checked = checkForStorage({ key: field.fieldKey, label: field.label, kind: field.kind,
    shape: field.shape, cardinality: field.cardinality, unitOptions: field.unitOptions, validation: field.validation }, single ? members[0] ?? null : value)
  // The first shape problem only, as before: a stored value is one sentence, not a list of every rule it misses.
  const shapeFinding = checked.ok === false ? finding('type', checked.error) : checked.findings[0]
  if (!info?.definition && shapeFinding && (!isBlankValue(value) || field.priority === 'required')) findings.push(shapeFinding)
  // An eBay item specific is measured as eBay receives it: each value, a legacy joined list as its parts.
  const itemSpecific = field.channelStore?.kind === 'platformAttributes' && field.channelStore.path[0] === 'itemSpecifics'
  const strings = itemSpecific ? ebayAspectValues(value) : (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string')
  const chars = Math.max(0, ...strings.map(v => v.length))
  const bytes = Math.max(0, ...strings.map(v => Buffer.byteLength(v, 'utf8')))
  const overLimit = {
    ...(field.maxLength && chars > field.maxLength ? { chars } : {}),
    ...(field.maxBytes && bytes > field.maxBytes ? { bytes } : {}),
  }
  // A single-value eBay item specific holding a joined list would be sent as its parts: more values than eBay takes.
  if (itemSpecific && (field.shape ?? 'scalar') === 'scalar' && !single && strings.length > 1) {
    findings.push(finding('count', `${field.label} takes one value; eBay would receive ${strings.length} (${strings.map(v => JSON.stringify(v)).join(', ')}).`))
  }
  if (overLimit.chars) findings.push(finding('length', `${field.label} exceeds ${field.maxLength} characters (${chars}).`))
  if (overLimit.bytes) findings.push(finding('length', `${field.label} exceeds ${field.maxBytes} UTF-8 bytes (${bytes}).`))
  return { value, errors: findings.map(f => f.message), findings, autoCorrected, overLimit: Object.keys(overLimit).length ? overLimit : null }
}
