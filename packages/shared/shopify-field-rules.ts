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
 * - B3b (G15, G16): `shopifyDateTimeMs` / `shopifyLimitMs` read a date and time strictly, with no zone = UTC;
 *   `shopifyDateTimeValue` writes the picker's moment in Shopify's form; `shopifyJsonProblem` says where JSON breaks.
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
/* ── Dates and moments (B3b, gap G15). Shopify documents `date_time` as "ISO 8601 format without a presumed timezone.
   Defaults to Greenwich Mean Time (GMT)" and writes its values and limits with no zone (`2024-01-01T12:30:00`;
   shopify.dev "List of data types" and "List of validation options", read 2026-09-28). So a value or a limit with no
   zone is UTC here — never the machine's zone, which `Date.parse` would use, so a browser in Rome and a server in UTC
   agreed on nothing. Parsed by hand: `Date.parse` also takes free text such as "Sep 28 2026". ── */

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const realDay = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= (m === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : MONTH_DAYS[m - 1])
/** `Date.UTC` reads years 0–99 as 1900–1999; set the year after. */
const utcMs = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => { const at = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms)); at.setUTCFullYear(y); return at.getTime() }

/** The moment of a strict ISO 8601 date and time (`YYYY-MM-DDTHH:MM[:SS[.fff]]`, then `Z`, `±HH:MM` or nothing = UTC),
 *  in ms since 1970 UTC. Null for free text or a day that is not in the calendar. */
export function shopifyDateTimeMs(text: string): number | null {
  const m = DATE_TIME.exec(text)
  if (!m) return null
  const [, y, mo, d, h, mi, s = '0', fraction = '', zone = 'Z'] = m
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59 || !realDay(Number(y), Number(mo), Number(d))) return null
  let offset = 0
  if (zone !== 'Z') {
    const oh = Number(zone.slice(1, 3)), om = Number(zone.slice(4))
    if (oh > 23 || om > 59) return null
    offset = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om)
  }
  return utcMs(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), Number(fraction.padEnd(3, '0').slice(0, 3))) - offset * 60000
}
/** A `date` (`YYYY-MM-DD`, a real day) as the moment it starts in UTC; null otherwise. */
export function shopifyDateMs(text: string): number | null {
  const m = DATE_ONLY.exec(text)
  return m && realDay(Number(m[1]), Number(m[2]), Number(m[3])) ? utcMs(Number(m[1]), Number(m[2]), Number(m[3])) : null
}
/** A `min` / `max` limit of a date or date-time field: a day (its start, UTC) or a strict date and time. */
export const shopifyLimitMs = (text: string): number | null => shopifyDateMs(text) ?? shopifyDateTimeMs(text)
/** A moment as the pop-up says it: "2026-09-28 12:30", with ":SS" only when the seconds are not zero. UTC. */
export function shopifyMomentWords(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, iso.slice(17, 19) === '00' ? 16 : 19)}`
}
/** The value the date-time picker writes: its UTC instant in Shopify's documented form, with no zone
 *  (`2026-09-28T12:30:00`); milliseconds only when they are not zero. */
export function shopifyDateTimeValue(instant: string): string {
  const iso = new Date(instant).toISOString()
  return iso.slice(0, iso.endsWith('.000Z') ? 19 : 23)
}

/**
 * Why a text is not JSON, in plain words ("the text ends where a value is needed", "“,” or “}” is needed at line 1,
 * character 8") — B3b, gap G16. Written here, not taken from the parser: V8, SpiderMonkey and JavaScriptCore word their
 * errors differently, and the pop-up (a browser) and the draft save (Node) must say the same words. Null for valid JSON.
 */
export function shopifyJsonProblem(text: string): string | null {
  if (!text.trim()) return 'it is empty'
  let i = 0
  class Stop { constructor(readonly words: string) {} }
  const place = (p: number) => { const lines = text.slice(0, p).split('\n'); return `line ${lines.length}, character ${[...lines[lines.length - 1]].length + 1}` }
  const fail = (words: string): never => { throw new Stop(words) }
  const need = (what: string): never => i >= text.length ? fail(`the text ends where ${what} is needed`) : fail(`${what} is needed at ${place(i)}`)
  const space = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++ }
  const LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
  const string = () => {
    const start = i++
    while (i < text.length && text[i] !== '"') {
      if (text.charCodeAt(i) < 0x20) fail(`a line break or tab inside quotes, at ${place(i)}, must be written as \\n or \\t`)
      if (text[i] === '\\') {
        if (!/^\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/.test(text.slice(i, i + 6))) fail(`the “\\” at ${place(i)} does not start a valid escape`)
        i += text[i + 1] === 'u' ? 6 : 2
      } else i++
    }
    if (i >= text.length) fail(`the text in quotes that starts at ${place(start)} is not closed`)
    i++
  }
  const value = (): void => {
    space()
    if (text[i] === '"') return string()
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i++] === '{', close = object ? '}' : ']'
      space()
      if (text[i] === close) { i++; return }
      for (;;) {
        if (object) { space(); if (text[i] !== '"') need('a name in double quotes'); string(); space(); if (text[i] !== ':') need('“:”'); i++ }
        value(); space()
        if (text[i] === ',') { i++; continue }
        if (text[i] === close) { i++; return }
        need(`“,” or “${close}”`)
      }
    }
    LITERAL.lastIndex = i
    const literal = LITERAL.exec(text)
    if (!literal) need('a value')
    i += literal![0].length
  }
  try {
    value(); space()
    return i < text.length ? `there is more text after the end, at ${place(i)}` : null
  } catch (e) { return e instanceof Stop ? e.words : 'check its quotes, commas and brackets' }
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
    /* A limit with a zone is said in UTC too, so the line never shows a time the check does not use (G15). */
    const at = (v: string) => { const ms = base === 'date_time' ? shopifyLimitMs(v) : null; return ms === null ? v : `${shopifyMomentWords(ms)} (UTC)` }
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
  /* The same moment in any spelling: `…T12:30:00`, `…T12:30:00Z` and `…T14:30:00+02:00` (no zone = UTC, G15). */
  if ((base === 'date' || base === 'date_time') && typeof x === 'string' && typeof y === 'string') {
    const read = base === 'date' ? shopifyDateMs : shopifyDateTimeMs, a = read(x)
    return a !== null && a === read(y)
  }
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
 * numbers the same number; for colours the same hex in any letter case; for a date and time the same moment (no zone =
 * UTC). Plain text compares exactly.
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
