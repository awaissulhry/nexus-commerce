/**
 * Shopify metafield rules in plain words, and value equality by type (Lane B slice B1,
 * docs/shopify-metafields/PLAN-2026-09-28.md §4.6, §5, gaps G6, G8, G10).
 *
 * - `shopifyRuleSummary`: the one short line the pop-up shows under a field ("Up to 10 values · up to 100 characters each"),
 *   instead of the raw rule table (`list.max` / `10`).
 * - `shopifyFileKind`: a file id already says its kind (`MediaImage` = Image, `Video` = Video), so a file limit can be checked
 *   without asking Shopify — a pasted wrong file is refused at the draft save, not first at publish.
 * - `shopifyValuesEqual`: whether two stored values are the same value for Shopify's type — for the read-back after a write,
 *   where Shopify may return the same JSON with other spacing or key order.
 *
 * Pure. Types only from `shopify-linked-products` (no runtime import, no cycle); the unit tables import nothing back.
 */
import type { ShopifyFieldDefinition, ShopifyStoreSchema } from './shopify-linked-products.js'
import { shopifyMeasurementUnits } from './shopify-field-codecs.js'
import { shopifyMeasurementLimitReadable } from './shopify-measurement-limits.js'

export interface ShopifyNoun { one: string; other: string }
const NOUNS: Record<string, ShopifyNoun> = {
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
  mixed_reference: { one: 'entry', other: 'entries' },
  disclosure_reference: { one: 'entry', other: 'entries' },
  product_taxonomy_value_reference: { one: 'value', other: 'values' },
}
const baseOf = (type: string) => type.replace(/^list\./, '')
/** The word for one / many items of a field: `list.product_reference` → product / products; plain values → value / values. */
export const shopifyNoun = (type: string): ShopifyNoun => NOUNS[baseOf(type)] ?? { one: 'value', other: 'values' }

/** `gid://shopify/MediaImage/1` → `Image`, `…/Video/1` → `Video`, a generic file or 3D model → `File`; anything else → null. */
export function shopifyFileKind(id: string): 'Image' | 'Video' | 'File' | null {
  const resource = /^gid:\/\/shopify\/([A-Za-z0-9]+)\/\d+$/.exec(id)?.[1]
  return resource === 'MediaImage' ? 'Image' : resource === 'Video' ? 'Video' : resource === 'GenericFile' || resource === 'Model3d' ? 'File' : null
}
/** `["Image","Video"]` → "images and videos". */
export function shopifyFileKindsWords(kinds: readonly string[]): string {
  const words = kinds.map(kind => kind === 'Image' ? 'images' : kind === 'Video' ? 'videos' : `${kind.toLowerCase()} files`)
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? 'files'
}

/** `"1.0"` → `"1"`, `"4.50"` → `"4.5"`: a number as people write it; anything else unchanged. */
export const plainNumber = (value: string) => {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) ? String(n) : value
}
const parse = (value: string): unknown => { try { return JSON.parse(value) } catch { return value } }
/** A measurement or money bound (`{"unit":"g","value":10}`) as words: "10 g". */
export function shopifyBoundWords(value: string): string {
  const bound = parse(value)
  if (bound && typeof bound === 'object' && !Array.isArray(bound)) {
    const b = bound as Record<string, unknown>
    if (b.value !== undefined) return `${plainNumber(String(b.value))} ${String(b.unit ?? '').replace(/_/g, ' ')}`.trim()
    if (b.amount !== undefined) return `${plainNumber(String(b.amount))} ${String(b.currency_code ?? '')}`.trim()
  }
  return typeof bound === 'string' || typeof bound === 'number' ? plainNumber(String(bound)) : value
}
const list = (items: readonly string[], shown = 6) => items.length > shown ? `${items.slice(0, shown).join(', ')}, …` : items.join(', ')
const joinOr = (items: readonly string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}` : items[0] ?? ''
const TEXT_TYPES = ['single_line_text_field', 'multi_line_text_field', 'id']
const NUMBER_TYPES = ['number_integer', 'number_decimal']
const DATE_TYPES = ['date', 'date_time']

/**
 * The field's rules as ONE short line of plain words ("Up to 10 products", "0 or more", "Images only · up to 6 files").
 * Empty when the field has no rules. Unknown future rules are left out here; the field's check still applies them.
 */
export function shopifyRuleSummary(def: Pick<ShopifyFieldDefinition, 'type' | 'validations' | 'required'>, schema?: Pick<ShopifyStoreSchema, 'metaobjectDefinitions'> | null): string {
  const isList = def.type.startsWith('list.'), base = baseOf(def.type), noun = shopifyNoun(def.type)
  const rule = (name: string) => def.validations.find(v => v.name === name)?.value
  const each = isList ? ' each' : ''
  const parts: string[] = []
  if (def.required) parts.push('Required')
  const choices = rule('choices')
  if (choices) { const values = parse(choices); if (Array.isArray(values)) parts.push(`One of: ${list(values.map(String))}`) }
  const min = rule('min'), max = rule('max')
  if (TEXT_TYPES.includes(base) && (min || max)) {
    parts.push(min && max ? (min === max ? `Exactly ${min} characters${each}` : `${min} to ${max} characters${each}`) : max ? `Up to ${max} characters${each}` : `At least ${min} characters${each}`)
  } else if (DATE_TYPES.includes(base) && (min || max)) {
    const at = (v: string) => base === 'date_time' ? `${v.replace('T', ' ').slice(0, 16)} (UTC)` : v
    parts.push(min && max ? `From ${at(min)} to ${at(max)}` : min ? `From ${at(min)}` : `Until ${at(max!)}`)
  } else if (min || max) {
    const low = min && shopifyBoundWords(min), high = max && shopifyBoundWords(max)
    parts.push(low && high ? `${low} to ${high}${each}` : low ? `${low} or more${each}` : `${high} or less${each}`)
    /* G14: a measurement limit in a unit Nexus cannot read is not checked in Nexus — say who checks it (PLAN §6.3). */
    if (shopifyMeasurementUnits[base]) {
      const limits = [min, max].filter((b): b is string => !!b), unread = limits.filter(b => !shopifyMeasurementLimitReadable(base, b))
      if (unread.length) parts.push(unread.length < limits.length ? `Shopify checks the ${shopifyBoundWords(unread[0])} limit when you publish` : `Shopify checks ${unread.length > 1 ? 'these limits' : 'this limit'} when you publish`)
    }
  }
  const precision = rule('max_precision')
  if (precision) parts.push(`Up to ${precision} decimal ${precision === '1' ? 'place' : 'places'}`)
  const scaleMin = rule('scale_min'), scaleMax = rule('scale_max')
  if (scaleMin && scaleMax) parts.push(`Rating ${plainNumber(scaleMin)} to ${plainNumber(scaleMax)}`)
  const regex = rule('regex')
  if (regex) parts.push(`Format: ${regex}`)
  const domains = rule('allowed_domains')
  if (domains) { const values = parse(domains); if (Array.isArray(values)) parts.push(`Only links on ${joinOr(values.map(String))}`) }
  if (rule('schema')) parts.push('Must match the store’s JSON schema')
  const files = rule('file_type_options')
  if (files) { const kinds = parse(files); if (Array.isArray(kinds) && kinds.length) { const words = shopifyFileKindsWords(kinds.map(String)); parts.push(`${words.charAt(0).toUpperCase()}${words.slice(1)} only`) } }
  const kindNames: string[] = []
  for (const v of def.validations) {
    if (!['metaobject_definition_id', 'metaobject_definition_ids', 'metaobject_definition_type', 'metaobject_definition_types'].includes(v.name)) continue
    const values = v.name.endsWith('s') ? parse(v.value) : [v.value]
    for (const value of Array.isArray(values) ? values.map(String) : []) {
      const kind = v.name.includes('_id') ? schema?.metaobjectDefinitions.find(d => d.id === value) : schema?.metaobjectDefinitions.find(d => d.type === value)
      kindNames.push(kind?.name ?? (v.name.includes('_id') ? 'an entry kind this store no longer has' : value))
    }
  }
  if (kindNames.length) parts.push(`${joinOr([...new Set(kindNames)])} entries`)
  const attribute = rule('product_taxonomy_attribute_handle')
  if (attribute) parts.push(`Shopify “${attribute}” values`)
  const listMin = rule('list.min'), listMax = rule('list.max')
  if (isList && (listMin || listMax)) {
    parts.push(listMin && listMax ? (listMin === listMax ? `Exactly ${listMin} ${noun.other}` : `${listMin} to ${listMax} ${noun.other}`) : listMax ? `Up to ${listMax} ${listMax === '1' ? noun.one : noun.other}` : `At least ${listMin} ${listMin === '1' ? noun.one : noun.other}`)
  }
  const line = parts.join(' · ')
  return line ? `${line.charAt(0).toUpperCase()}${line.slice(1)}` : ''
}

/* ── Value equality by type (read-back after a write, G10). ── */

const NUMERIC_FIELDS: Record<string, readonly string[]> = { rating: ['value', 'scale_min', 'scale_max'], money: ['amount'] }
const MEASURE_FIELDS = ['value']
function sameJson(base: string, x: unknown, y: unknown, key?: string): boolean {
  if (x === y) return true
  const numericKey = key !== undefined && ((NUMERIC_FIELDS[base] ?? []).includes(key) || (MEASURE_FIELDS.includes(key) && !['json', 'rich_text_field', 'link', 'money', 'rating'].includes(base)))
  if (numericKey && (typeof x === 'string' || typeof x === 'number') && (typeof y === 'string' || typeof y === 'number')) {
    return String(x).trim() !== '' && String(y).trim() !== '' && Number(x) === Number(y)
  }
  if (Array.isArray(x) || Array.isArray(y)) return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((item, i) => sameItem(base, item, y[i]))
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const a = x as Record<string, unknown>, b = y as Record<string, unknown>
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every(k => sameJson(base, a[k], b[k], k))
  }
  return false
}
/** One scalar item (of a list, or the whole value) the same for its type. */
function sameItem(base: string, x: unknown, y: unknown): boolean {
  if (x === y) return true
  if (base === 'color' && typeof x === 'string' && typeof y === 'string') return x.toLowerCase() === y.toLowerCase()
  if ((base === 'number_integer' || base === 'number_decimal') && (typeof x === 'string' || typeof x === 'number') && (typeof y === 'string' || typeof y === 'number')) {
    return String(x).trim() !== '' && String(y).trim() !== '' && Number(x) === Number(y) && Number.isFinite(Number(x))
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') return sameJson(base, x, y)
  return false
}
const STRUCTURED_SCALARS = new Set(['money', 'rating', 'link', 'json', 'rich_text_field'])

/**
 * Whether two stored values of one Shopify type are the same value: equal text; for lists and structured values the same
 * JSON (spacing and key order do not matter; the numbers inside a rating, money or measurement compare as numbers); for
 * numbers the same number; for colours the same hex in any letter case. Dates and plain text compare exactly.
 */
export function shopifyValuesEqual(type: string, a: string | null, b: string | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  const isList = type.startsWith('list.'), base = baseOf(type)
  const measurement = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value) && 'unit' in (value as object)
  if (isList || STRUCTURED_SCALARS.has(base)) {
    const x = parse(a), y = parse(b)
    if (typeof x === 'string' || typeof y === 'string') return false
    return sameJson(base, x, y)
  }
  const x = parse(a), y = parse(b)
  if (measurement(x) && measurement(y)) return sameJson(base, x, y)
  return sameItem(base, a, b)
}
