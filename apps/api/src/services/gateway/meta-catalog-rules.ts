/**
 * Meta step 34 (2026-10-21) — the write allow-list entries of create-meta-catalog, set-meta-catalog,
 * set-meta-catalog-access, set-meta-product-set and remove-meta-catalog-items (D7: Shopify keeps writing items, so no item
 * FIELD is written here; items are only deleted, on explicit ask, where Nexus may write items). EXACT keys per edge and
 * kind, every value judged, JSON in one spelling only (as Nexus writes it) with every key allow-listed at every depth, text
 * only where a person types it. The object of every rule is confirmed by the gateway before anything is sent (gateway.ts →
 * meta-catalog-owner.ts): a catalog this business may write (owned by the chosen ad account's business portfolio, which no
 * other Nexus business uses, and shared with no portfolio one does), a product set, item or feed of such a catalog, the
 * chosen portfolio itself for a new catalog — and every id inside a body (meta-catalog-owner.ts metaCatalogBodyChecker).
 *
 * Import rule (lane C4, step 34): this file imports no VALUE from meta-settings-rules.ts or meta-calls.ts (main's sleeping
 * import cycle between them): only types, the leaf text patterns (meta-write-text.ts, a byte-identical copy of step 39's)
 * and the leaf catalog lists (services/meta/meta-catalog-lists.ts). Its canonical-JSON helper is therefore its own (as
 * step 39's meta-brand-safety-rules.ts), the same three lines as meta-settings-rules.ts metaCanonicalJson.
 *
 * Checked 2026-10-21 (curl ≥ 3 s apart, developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md,
 * and Meta's Python Business SDK main, facebook_business/adobjects/{productcatalog,productset,business,productitem,
 * productfeed}.py):
 *   - business/owned_product_catalogs "Creating": name [required], vertical (default commerce), parent_catalog_id +
 *     catalog_segment_filter (a segment: marketing-api/collaborative-ads.md "required for catalog segment creation"; error
 *     2310019 "The business of this catalog is not onboarded to Collaborative Ads"), da_display_settings {carousel_ad,
 *     single_ad} each {transformation_type} (both required), business_metadata, partner_integration (a partner's access
 *     token: never sent), store_catalog_settings, additional_vertical_option, destination_ / flight_catalog_settings (other
 *     verticals): none of these is sent; returns {id} (read-after-write); error 804 "already exists". The SDK also names
 *     catalog_segment_product_set_id (RECHECK CT-011 CORRECTED: the guide's segment is the filter — not sent).
 *   - product-catalog "Updating": name, default_image_url, fallback_image_url (URI), da_display_settings → {success};
 *     "Deleting": DELETE /{catalog} with allow_delete_catalog_with_live_product_set (default false; 3970 = catalog admin
 *     only; "You cannot remove a product catalog from a Business Manager"); DELETE /{catalog}/external_event_sources with
 *     external_event_sources=[…] and DELETE /{catalog}/assigned_users with user — each a form body (the page's own curl).
 *   - product-catalog/categories "Creating": data list<{categorization_criteria BRAND | CATEGORY | PRODUCT_TYPE [required],
 *     criteria_value [required], name, description, destination_uri, image_url, tokens}> → {updated, skipped, total,
 *     details}; advantage-catalog-ads/get-started.md: name ≤ 40, description ≤ 20 characters, destination_uri needed the
 *     first time, an empty destination_uri skips the category, "Deleting a category is not supported at this time". tokens
 *     (meaning undocumented) is never sent.
 *   - product-catalog/external_event_sources "Creating": external_event_sources ("An array of event source ids").
 *   - product-catalog/assigned_users "Creating": user [required] (a business or system user), tasks [required] ⊂ MANAGE,
 *     ADVERTISE, MANAGE_AR, AA_ANALYZE; error 415 (two-factor).
 *   - agencies: product-catalog/agencies is in Meta's index but its page is not found (RECHECK-C4 CT-017); SDK
 *     productcatalog.py create_agency (business, permitted_tasks ⊂ AA_ANALYZE, ADVERTISE, MANAGE, MANAGE_AR, permitted_roles,
 *     enabled_collab_terms ⊂ ENFORCE_CREATE_NEW_AD_ACCOUNT, ENFORCE_SHARE_AD_PERFORMANCE_ACCESS, skip_defaults, utm_settings)
 *     and delete_agencies (business); collaborative-ads.md for a segment: business + permitted_tasks [ADVERTISE, MANAGE]
 *     required, utm_settings {campaign_source, campaign_medium, campaign_name}, enabled_collab_terms. Nexus ALWAYS sends
 *     business + permitted_tasks; permitted_roles and skip_defaults (meaning undocumented) never (LIVE-PROBES CA34-03).
 *   - product-catalog/product_sets "Creating" and product-set "Updating": name [required on create], filter (≤ 500 KiB),
 *     metadata {cover_image_url, description, external_url, external_url_handle}, publish_to_shops [{shop_id,
 *     ordering_index}], retailer_id → {id}; 10803 = a set with the same filter exists; product-set "Deleting":
 *     allow_live_product_set_deletion (default false). ordering_info is SDK-only and its meaning undocumented (RECHECK-C4
 *     CT-067): never sent.
 *   - product-catalog/items_batch: item_type [required] (PRODUCT_ITEM), requests [required] ≤ 5,000 ({method, data}; a DELETE
 *     of a PRODUCT_ITEM names only `id`, its retailer id), allow_upsert (default true: always sent, false), ≤ 28 MB;
 *     80014 = the catalog's batch limit; answers {handles, validation_status}. /{catalog}/batch (gone in v27) is never sent.
 *   - product-item "Deleting": DELETE /{product_item_id}, no parameters (801); product-feed "Deleting": DELETE
 *     /{product_feed_id}, no parameters ("Deleting a product feed effectively disables all ads using products that come
 *     from this feed"; 3964 = feed admin only).
 *   - product-catalog/update_generated_image_config (CT-177): its body is on no page and not in the SDK (RECHECK-C4): no rule.
 * No rule takes execution_options: Meta documents validate_only on none of these edges.
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from './meta-write-text.js'
import {
  META_SET_ENUM_OPS, META_SET_FILTER_ENUMS, META_SET_FILTER_MAX_BYTES, META_SET_FILTER_PRICE_FIELDS, META_SET_FILTER_TEXT_FIELDS, META_SET_LABEL_FIELD,
  META_SET_LIST_OPS, META_SET_MAX_VALUE_CHARS, META_SET_MAX_VALUES, META_SET_PRICE_OPS, META_SET_TEXT_OPS,
} from '../meta/meta-catalog-lists.js'

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

// ── the kinds a catalog change names (the gateway confirms each: meta-catalog-owner.ts) ─────────────────────────────

/** The object a catalog change names by its path: a catalog, a product set, an item, a feed, the portfolio a catalog is made in. */
export type MetaCatalogKind = 'catalog' | 'productset' | 'productitem' | 'productfeed' | 'catalogbusiness'
export const META_CATALOG_KINDS: readonly MetaCatalogKind[] = ['catalog', 'productset', 'productitem', 'productfeed', 'catalogbusiness']
export const isMetaCatalogKind = (kind: string | undefined): kind is MetaCatalogKind => !!kind && (META_CATALOG_KINDS as readonly string[]).includes(kind)
/**
 * Ids inside a catalog change's body: a segment's parent catalog, a pixel connected (the chosen ad account's) or an event
 * source disconnected (the catalog's own), a person given access (the portfolio's) or removed (the catalog's, never Nexus's
 * own system user), a partner portfolio shared with (no Nexus business's, never this one's) or unshared (the catalog's), a
 * shop a set is published to (the chosen Page's).
 */
export type MetaCatalogBodyKind = 'catalogparent' | 'catalogpixel' | 'catalogsource' | 'catalogperson' | 'catalogassignee' | 'catalogagency' | 'catalogpartner' | 'catalogshop'
export const META_CATALOG_BODY_KINDS: readonly MetaCatalogBodyKind[] = ['catalogparent', 'catalogpixel', 'catalogsource', 'catalogperson', 'catalogassignee', 'catalogagency', 'catalogpartner', 'catalogshop']
export const isMetaCatalogBodyKind = (kind: string | undefined): kind is MetaCatalogBodyKind => !!kind && (META_CATALOG_BODY_KINDS as readonly string[]).includes(kind)

// ── limits and lists the tools and drafts share ───────────────────────────────────────────────────────────────────────

/** Nexus's own limit on a catalog's or a set's name (Meta documents none). */
export const META_CATALOG_NAME_MAX = 100
/** advantage-catalog-ads/get-started.md: a category's name ≤ 40, its description ≤ 20 characters. */
export const META_CATEGORY_NAME_MAX = 40
export const META_CATEGORY_DESCRIPTION_MAX = 20
/** Nexus's own: a category's value (a brand, a category, a product type), as long as a set filter value. */
export const META_CATEGORY_VALUE_MAX = META_SET_MAX_VALUE_CHARS
/** Nexus's own: at most this many categories in one change. */
export const MAX_CATALOG_CATEGORIES = 25
/** Nexus's own: at most this many pixels / event sources in one change. */
export const MAX_EVENT_SOURCES = 20
/** Nexus's own: at most this many items deleted by one request (Meta takes 5,000 in a batch; Nexus reads each first). */
export const MAX_ITEM_DELETES = 250
/** items_batch: an item's id (its retailer id, the SKU) is at most 100 characters (facts F2, FIELDS). */
export const META_RETAILER_ID_MAX = 100
/** Nexus's own: the longest URL sent (an image, a landing page). */
export const META_URL_MAX = 2000
/** Nexus's own: a collection's description and handle. */
export const META_COLLECTION_DESCRIPTION_MAX = 1000
export const META_COLLECTION_HANDLE = /^[A-Za-z0-9_-]{1,100}$/
/** Nexus's own: at most this many shops a set is published to. */
export const MAX_SET_SHOPS = 20
/** Nexus's own: a UTM value's length. */
export const META_UTM_MAX = 100
export const META_IMAGE_TRANSFORMATIONS = ['background_cropping_and_padding', 'background_padding', 'none'] as const
export const META_CATEGORY_CRITERIA = ['BRAND', 'CATEGORY', 'PRODUCT_TYPE'] as const
export const META_CATALOG_TASKS = ['MANAGE', 'ADVERTISE', 'MANAGE_AR', 'AA_ANALYZE'] as const
/** collaborative-ads.md: a segment is shared with ADVERTISE and / or MANAGE only. */
export const META_SEGMENT_TASKS = ['MANAGE', 'ADVERTISE'] as const
export const META_COLLAB_TERMS = ['ENFORCE_CREATE_NEW_AD_ACCOUNT', 'ENFORCE_SHARE_AD_PERFORMANCE_ACCESS'] as const
export const META_UTM_KEYS = ['campaign_source', 'campaign_medium', 'campaign_name'] as const
/** Nexus's own: an and / or list holds at most this many parts (step 13 sends at most 20 conditions). */
const MAX_RULE_PARTS = 50
const MAX_RULE_DEPTH = 10
/** Meta's price × 100 is an int: Nexus's own ceiling (far above any price). */
const MAX_PRICE_AMOUNT = 100_000_000_000

/** A form body of a JSON value of `bytes` UTF-8 bytes is at most 3 × that long (each byte at worst %XX), plus the rest. */
const formOf = (bytes: number) => 3 * bytes
/** The longest body of a rule that carries a set or segment filter: Meta's 500 KiB, form-encoded, plus the other keys. */
export const META_FILTER_BODY_MAX = formOf(META_SET_FILTER_MAX_BYTES) + 40_000

// ── small judges ──────────────────────────────────────────────────────────────────────────────────────────────────────

const DIGITS = /^\d{1,20}$/
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const chars = (v: string) => [...v].length

/** A JSON value written the one way Nexus writes it (JSON.stringify of what it parses to), or undefined. */
function canonicalJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}

const json = (what: string, judge: (parsed: unknown) => string | null): Judge => (value) => {
  const parsed = canonicalJson(value)
  if (parsed === undefined) return `${what} is JSON in one spelling only (as Nexus writes it: no spaces, each key once)`
  return judge(parsed)
}
const exactly = (want: string, what: string): Judge => (value) => (value === want ? null : `${what} is exactly ${want}`)
const digits = (what: string): Judge => (value) => (DIGITS.test(value) ? null : `${what} is a Meta id (digits only)`)

/** Text a person typed: trimmed, 1 to max characters, its pattern (no control or format character). */
export function metaCatalogTextOk(v: unknown, max: number, pattern: RegExp = META_NAME_TEXT): v is string {
  return typeof v === 'string' && v === v.trim() && v.length > 0 && chars(v) <= max && pattern.test(v)
}
const text = (what: string, max: number, pattern: RegExp = META_NAME_TEXT): Judge => (value) =>
  (metaCatalogTextOk(value, max, pattern) ? null : `${what} is 1 to ${max} characters of text, with no space at either end and no control or format character`)

/** An https address Nexus sends (an image, a landing page): plain ASCII, no user or password, at most META_URL_MAX. */
export function metaHttpsUrlOk(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > META_URL_MAX || !/^[\x21-\x7e]+$/.test(v)) return false
  try {
    const url = new URL(v)
    return url.protocol === 'https:' && !url.username && !url.password && !!url.hostname && url.href.length <= META_URL_MAX + 10
  } catch {
    return false
  }
}
const httpsUrl = (what: string): Judge => (value) => (metaHttpsUrlOk(value) ? null : `${what} is an https address (at most ${META_URL_MAX} characters, no user or password)`)

/** A JSON list of 1..max distinct values from `allowed`. */
const listOf = (what: string, allowed: readonly string[], max: number = allowed.length, min = 1): Judge => json(what, (v) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) return `${what} lists ${min} to ${max} values`
  if (!v.every((x) => typeof x === 'string' && allowed.includes(x))) return `${what} lists only ${allowed.join(', ')}`
  return new Set(v).size === v.length ? null : `${what} names each value once`
})
/** A JSON list of 1..max distinct Meta ids, each a string of digits. */
const idList = (what: string, max: number): Judge => json(what, (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) return `${what} lists 1 to ${max} ids`
  if (!v.every((x) => typeof x === 'string' && DIGITS.test(x))) return `${what} lists Meta ids, each a string of digits`
  return new Set(v).size === v.length ? null : `${what} names each id once`
})
const idsIn = (value: string | undefined): string[] => {
  const parsed = value === undefined ? undefined : canonicalJson(value)
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && DIGITS.test(x)) : []
}

/** Each key's judge, then the body's own rule. */
const judgedBy = (judges: Record<string, Judge>, also?: (params: Params) => string | null) => (params: Params): string | null => {
  for (const [key, value] of params) {
    const judge = judges[key]
    if (!judge) return `${key} is not a key of this change`
    const problem = judge(value, params)
    if (problem) return problem
  }
  return also ? also(params) : null
}

// ── a product-set (or segment) filter, judged at every depth ───────────────────────────────────────────────────────

const TEXT_FIELDS: ReadonlySet<string> = new Set(META_SET_FILTER_TEXT_FIELDS)
const PRICE_FIELDS: ReadonlySet<string> = new Set(META_SET_FILTER_PRICE_FIELDS)
const ENUM_FIELDS = META_SET_FILTER_ENUMS as Readonly<Record<string, readonly string[]>>

/** One value of a text or enum condition: 1..200 characters, no control or format character, plain ASCII for a label. */
function filterValueProblem(field: string, v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '' || chars(v) > META_SET_MAX_VALUE_CHARS || !META_STRICT_TEXT.test(v)) {
    return `a filter value on ${field} is 1 to ${META_SET_MAX_VALUE_CHARS} characters of text (no control or format character)`
  }
  if (META_SET_LABEL_FIELD.test(field) && !/^[\x20-\x7e]+$/.test(v)) return `Meta takes no non-English characters in a label filter (${field})`
  if (Object.prototype.hasOwnProperty.call(ENUM_FIELDS, field) && !ENUM_FIELDS[field].includes(v)) return `${field} is one of Meta's values (${ENUM_FIELDS[field].join(', ')})`
  return null
}

/** One condition `{ "<op>": value }` on `field`, as step 13's productSetFilter writes it (or as Meta stores one). */
function conditionProblem(field: string, condition: unknown): string | null {
  if (!plainObject(condition) || Object.keys(condition).length !== 1) return `a filter condition on ${field} is one operator and its value`
  const [op, v] = Object.entries(condition)[0]
  const isPrice = PRICE_FIELDS.has(field)
  const isEnum = Object.prototype.hasOwnProperty.call(ENUM_FIELDS, field)
  const ops = isPrice ? META_SET_PRICE_OPS : isEnum ? META_SET_ENUM_OPS : META_SET_TEXT_OPS
  if (!ops.has(op)) return `${field} takes ${[...ops].join(', ')} (not ${op})`
  if (op === 'starts_with' && field !== 'category') return 'Meta allows starts_with on category only'
  if (isPrice) return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_PRICE_AMOUNT ? null : `${field} compares a whole number (Meta's price × 100)`
  if (META_SET_LIST_OPS.has(op)) {
    if (!Array.isArray(v) || v.length < 1 || v.length > META_SET_MAX_VALUES) return `${op} on ${field} takes a list of 1 to ${META_SET_MAX_VALUES} values`
    for (const x of v) { const problem = filterValueProblem(field, x); if (problem) return problem }
    return new Set(v).size === v.length ? null : `${op} on ${field} names each value once`
  }
  return filterValueProblem(field, v)
}

/** A rule node: and / or of 1..50 nodes, or fields each with one condition. Every key at every depth is allow-listed. */
function ruleNodeProblem(node: unknown, depth: number): string | null {
  if (depth > MAX_RULE_DEPTH) return `a filter is at most ${MAX_RULE_DEPTH} levels deep`
  if (!plainObject(node) || Object.keys(node).length === 0) return 'every part of a filter names a field or and / or'
  for (const [key, value] of Object.entries(node)) {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RULE_PARTS) return `${key} in a filter lists 1 to ${MAX_RULE_PARTS} parts`
      for (const part of value) { const problem = ruleNodeProblem(part, depth + 1); if (problem) return problem }
      continue
    }
    if (!TEXT_FIELDS.has(key) && !PRICE_FIELDS.has(key) && !Object.prototype.hasOwnProperty.call(ENUM_FIELDS, key)) return `"${key.slice(0, 40)}" is not a field Nexus filters on`
    const problem = conditionProblem(key, value)
    if (problem) return problem
  }
  return null
}

/**
 * A set's or a segment's filter: `{}` (every item of the catalog, said explicitly by the tool), or a rule of step 13's
 * fields and operators (live-commerce.ts productSetFilter writes it), in one spelling, at most Meta's 500 KiB (UTF-8 bytes).
 */
export function metaSetFilterProblem(value: string, what = 'filter'): string | null {
  if (Buffer.byteLength(value, 'utf8') > META_SET_FILTER_MAX_BYTES) return `${what} is at most ${META_SET_FILTER_MAX_BYTES} bytes (Meta: 500 KiB)`
  const rule = canonicalJson(value)
  if (rule === undefined) return `${what} is JSON in one spelling only (as Nexus writes it: no spaces, each key once)`
  if (plainObject(rule) && Object.keys(rule).length === 0) return null
  return ruleNodeProblem(rule, 0)
}
const filterJudge = (what: string): Judge => (value) => metaSetFilterProblem(value, what)

// ── the other JSON values ─────────────────────────────────────────────────────────────────────────────────────────────

/** da_display_settings: exactly {carousel_ad, single_ad}, each exactly {transformation_type}: both required (CT-009). */
const displaySettings: Judge = json('da_display_settings', (v) => {
  if (!plainObject(v) || Object.keys(v).sort().join(',') !== 'carousel_ad,single_ad') return 'da_display_settings names carousel_ad and single_ad, both (Meta requires both), and nothing else'
  for (const key of ['carousel_ad', 'single_ad']) {
    const part = v[key]
    if (!plainObject(part) || Object.keys(part).join(',') !== 'transformation_type' || !(META_IMAGE_TRANSFORMATIONS as readonly string[]).includes(part.transformation_type as string)) {
      return `${key} is {"transformation_type": ${META_IMAGE_TRANSFORMATIONS.join(' | ')}}`
    }
  }
  return null
})

const CATEGORY_KEYS = ['categorization_criteria', 'criteria_value', 'name', 'description', 'destination_uri', 'image_url']
/** categories `data`: 1..25 categories, each its criteria and value, and only Meta's documented display fields. */
const categoriesData: Judge = json('data', (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CATALOG_CATEGORIES) return `data lists 1 to ${MAX_CATALOG_CATEGORIES} categories`
  const seen = new Set<string>()
  for (const [i, c] of v.entries()) {
    const at = `category ${i + 1}`
    if (!plainObject(c) || !Object.keys(c).every((k) => CATEGORY_KEYS.includes(k))) return `${at} names only ${CATEGORY_KEYS.join(', ')}`
    if (!(META_CATEGORY_CRITERIA as readonly string[]).includes(c.categorization_criteria as string)) return `${at}: categorization_criteria is ${META_CATEGORY_CRITERIA.join(', ')}`
    if (!metaCatalogTextOk(c.criteria_value, META_CATEGORY_VALUE_MAX, META_STRICT_TEXT)) return `${at}: criteria_value is 1 to ${META_CATEGORY_VALUE_MAX} characters of text`
    if (c.name !== undefined && !metaCatalogTextOk(c.name, META_CATEGORY_NAME_MAX)) return `${at}: name is 1 to ${META_CATEGORY_NAME_MAX} characters (Meta)`
    if (c.description !== undefined && !metaCatalogTextOk(c.description, META_CATEGORY_DESCRIPTION_MAX)) return `${at}: description is 1 to ${META_CATEGORY_DESCRIPTION_MAX} characters (Meta)`
    if (c.destination_uri !== undefined && c.destination_uri !== '' && !metaHttpsUrlOk(c.destination_uri)) return `${at}: destination_uri is an https address, or empty (Meta skips the category)`
    if (c.image_url !== undefined && !metaHttpsUrlOk(c.image_url)) return `${at}: image_url is an https address`
    if (Object.keys(c).length < 3) return `${at} changes nothing (name, description, destination_uri or image_url)`
    const key = `${c.categorization_criteria}:${c.criteria_value}`
    if (seen.has(key)) return `${at} names a category twice`
    seen.add(key)
  }
  return null
})

/** utm_settings: 1..3 of campaign_source, campaign_medium, campaign_name, each 1..100 characters of text. */
const utmSettings: Judge = json('utm_settings', (v) => {
  if (!plainObject(v) || Object.keys(v).length < 1 || !Object.keys(v).every((k) => (META_UTM_KEYS as readonly string[]).includes(k))) return `utm_settings names 1 to 3 of ${META_UTM_KEYS.join(', ')}`
  return Object.values(v).every((x) => metaCatalogTextOk(x, META_UTM_MAX, META_STRICT_TEXT)) ? null : `each utm_settings value is 1 to ${META_UTM_MAX} characters of text`
})

const METADATA_KEYS = ['cover_image_url', 'description', 'external_url', 'external_url_handle']
/** metadata (a shop collection's): 1..4 of Meta's documented keys, each judged. */
const setMetadata: Judge = json('metadata', (v) => {
  if (!plainObject(v) || Object.keys(v).length < 1 || !Object.keys(v).every((k) => METADATA_KEYS.includes(k))) return `metadata names 1 to 4 of ${METADATA_KEYS.join(', ')}`
  if (v.cover_image_url !== undefined && !metaHttpsUrlOk(v.cover_image_url)) return 'metadata.cover_image_url is an https address'
  if (v.external_url !== undefined && !metaHttpsUrlOk(v.external_url)) return 'metadata.external_url is an https address'
  if (v.description !== undefined && !metaCatalogTextOk(v.description, META_COLLECTION_DESCRIPTION_MAX, META_STRICT_TEXT)) return `metadata.description is 1 to ${META_COLLECTION_DESCRIPTION_MAX} characters of text`
  if (v.external_url_handle !== undefined && !(typeof v.external_url_handle === 'string' && META_COLLECTION_HANDLE.test(v.external_url_handle))) return 'metadata.external_url_handle is 1 to 100 letters, digits, _ or -'
  return null
})

/**
 * publish_to_shops: [{shop_id, ordering_index}] — 1..20 shops. Review B2: an empty list (out of every shop) is on no page and
 * cannot be read back, so it is never sent (LIVE-PROBES CA34-08).
 */
const shopsList: Judge = json('publish_to_shops', (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_SET_SHOPS) return `publish_to_shops lists 1 to ${MAX_SET_SHOPS} shops (Meta documents no way to take a set out of every shop)`
  for (const s of v) {
    if (!plainObject(s) || Object.keys(s).sort().join(',') !== 'ordering_index,shop_id') return 'each shop of publish_to_shops is exactly {"shop_id": "<digits>", "ordering_index": <whole number>}'
    if (typeof s.shop_id !== 'string' || !DIGITS.test(s.shop_id)) return 'shop_id is a Meta id (a string of digits)'
    if (!Number.isSafeInteger(s.ordering_index) || (s.ordering_index as number) < 0 || (s.ordering_index as number) > 1_000_000) return 'ordering_index is a whole number from 0'
  }
  return new Set(v.map((s) => (s as Record<string, unknown>).shop_id)).size === v.length ? null : 'publish_to_shops names each shop once'
})
const shopIds = (params: Params): MetaWriteBodyId[] => {
  const parsed = params.has('publish_to_shops') ? canonicalJson(params.get('publish_to_shops')!) : undefined
  return Array.isArray(parsed) ? parsed.map((s) => (s as Record<string, unknown>)?.shop_id).filter((id): id is string => typeof id === 'string' && DIGITS.test(id)).map((id) => ({ id, kind: 'catalogshop' as const })) : []
}

/** items_batch `requests` of a DELETE: 1..250 records, each exactly {"method":"DELETE","data":{"id":"<retailer id>"}}. */
const deleteRequests: Judge = json('requests', (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_ITEM_DELETES) return `requests lists 1 to ${MAX_ITEM_DELETES} deletes`
  const ids = new Set<string>()
  for (const r of v) {
    if (!plainObject(r) || Object.keys(r).join(',') !== 'method,data' || r.method !== 'DELETE') return 'each request is exactly {"method": "DELETE", "data": {"id": …}}: Nexus writes no item field here (D7)'
    const data = r.data
    if (!plainObject(data) || Object.keys(data).join(',') !== 'id' || !metaCatalogTextOk(data.id, META_RETAILER_ID_MAX, META_STRICT_TEXT)) return `each delete names only the item's id (its retailer id, 1 to ${META_RETAILER_ID_MAX} characters)`
    if (ids.has(data.id as string)) return 'requests names each item once'
    ids.add(data.id as string)
  }
  return null
})

// ── the rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const CATALOG_PATH = /^\d{1,20}$/
const SET_TEXT = { name: META_NAME_TEXT, filter: META_STRICT_TEXT, retailer_id: META_STRICT_TEXT, metadata: META_STRICT_TEXT }
const setJudges = (): Record<string, Judge> => ({
  name: text('name', META_CATALOG_NAME_MAX),
  filter: filterJudge('filter'),
  retailer_id: text('retailer_id', META_RETAILER_ID_MAX, META_STRICT_TEXT),
  metadata: setMetadata,
  publish_to_shops: shopsList,
})

/** Step 34's rules on the write allow-list (meta-calls.ts writeRules). */
export const META_CATALOG_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // create-meta-catalog: POST /{chosen portfolio}/owned_product_catalogs name, vertical=commerce [, da_display_settings].
    name: 'catalog.create',
    method: 'POST',
    path: /^\d{1,20}\/owned_product_catalogs$/,
    kinds: ['catalogbusiness'],
    required: ['name', 'vertical'],
    optional: ['da_display_settings'],
    text: { name: META_NAME_TEXT },
    maxBody: 4000,
    values: judgedBy({ name: text('name', META_CATALOG_NAME_MAX), vertical: exactly('commerce', 'vertical'), da_display_settings: displaySettings }),
    budget: false,
  },
  {
    // create-meta-catalog segmentOf: the same edge with parent_catalog_id (a catalog of this business) + catalog_segment_filter.
    name: 'catalog.segment.create',
    method: 'POST',
    path: /^\d{1,20}\/owned_product_catalogs$/,
    kinds: ['catalogbusiness'],
    required: ['name', 'parent_catalog_id', 'catalog_segment_filter'],
    optional: [],
    text: { name: META_NAME_TEXT, catalog_segment_filter: META_STRICT_TEXT },
    maxBody: META_FILTER_BODY_MAX,
    values: judgedBy({ name: text('name', META_CATALOG_NAME_MAX), parent_catalog_id: digits('parent_catalog_id'), catalog_segment_filter: filterJudge('catalog_segment_filter') }),
    budget: false,
    ids: (params) => (DIGITS.test(params.get('parent_catalog_id') ?? '') ? [{ id: params.get('parent_catalog_id')!, kind: 'catalogparent' }] : []),
  },
  {
    // set-meta-catalog settings: POST /{catalog} name, default_image_url, fallback_image_url, da_display_settings.
    name: 'catalog.update',
    method: 'POST',
    path: CATALOG_PATH,
    kinds: ['catalog'],
    required: [],
    optional: ['name', 'default_image_url', 'fallback_image_url', 'da_display_settings'],
    anyOf: ['name', 'default_image_url', 'fallback_image_url', 'da_display_settings'],
    text: { name: META_NAME_TEXT },
    maxBody: 16_000,
    values: judgedBy({ name: text('name', META_CATALOG_NAME_MAX), default_image_url: httpsUrl('default_image_url'), fallback_image_url: httpsUrl('fallback_image_url'), da_display_settings: displaySettings }),
    budget: false,
  },
  {
    // set-meta-catalog categories: POST /{catalog}/categories data=[…] (CR-460).
    name: 'catalog.categories',
    method: 'POST',
    path: /^\d{1,20}\/categories$/,
    kinds: ['catalog'],
    required: ['data'],
    optional: [],
    text: { data: META_STRICT_TEXT },
    maxBody: 500_000,
    values: judgedBy({ data: categoriesData }),
    budget: false,
  },
  {
    // set-meta-catalog connect: POST /{catalog}/external_event_sources — pixels of the chosen ad account (CT-121).
    name: 'catalog.eventsources.connect',
    method: 'POST',
    path: /^\d{1,20}\/external_event_sources$/,
    kinds: ['catalog'],
    required: ['external_event_sources'],
    optional: [],
    values: judgedBy({ external_event_sources: idList('external_event_sources', MAX_EVENT_SOURCES) }),
    budget: false,
    ids: (params) => idsIn(params.get('external_event_sources')).map((id) => ({ id, kind: 'catalogpixel' as const })),
  },
  {
    // set-meta-catalog disconnect: DELETE /{catalog}/external_event_sources — sources connected to this catalog (CT-122).
    name: 'catalog.eventsources.disconnect',
    method: 'DELETE',
    path: /^\d{1,20}\/external_event_sources$/,
    kinds: ['catalog'],
    required: ['external_event_sources'],
    optional: [],
    values: judgedBy({ external_event_sources: idList('external_event_sources', MAX_EVENT_SOURCES) }),
    budget: false,
    ids: (params) => idsIn(params.get('external_event_sources')).map((id) => ({ id, kind: 'catalogsource' as const })),
  },
  {
    // set-meta-catalog-access: POST /{catalog}/assigned_users user + tasks — a person or system user of the portfolio (CT-014).
    name: 'catalog.users.assign',
    method: 'POST',
    path: /^\d{1,20}\/assigned_users$/,
    kinds: ['catalog'],
    required: ['user', 'tasks'],
    optional: [],
    values: judgedBy({ user: digits('user'), tasks: listOf('tasks', META_CATALOG_TASKS) }),
    budget: false,
    ids: (params) => (DIGITS.test(params.get('user') ?? '') ? [{ id: params.get('user')!, kind: 'catalogperson' }] : []),
  },
  {
    // set-meta-catalog-access: DELETE /{catalog}/assigned_users user — someone assigned now, never Nexus's own (CT-015).
    name: 'catalog.users.remove',
    method: 'DELETE',
    path: /^\d{1,20}\/assigned_users$/,
    kinds: ['catalog'],
    required: ['user'],
    optional: [],
    values: judgedBy({ user: digits('user') }),
    budget: false,
    ids: (params) => (DIGITS.test(params.get('user') ?? '') ? [{ id: params.get('user')!, kind: 'catalogassignee' }] : []),
  },
  {
    // set-meta-catalog-access share: POST /{catalog}/agencies business + permitted_tasks ALWAYS; utm / collab terms: a
    // segment only (the gateway reads the catalog: meta-catalog-owner.ts) (CT-017, CT-134).
    name: 'catalog.agencies.share',
    method: 'POST',
    path: /^\d{1,20}\/agencies$/,
    kinds: ['catalog'],
    required: ['business', 'permitted_tasks'],
    optional: ['enabled_collab_terms', 'utm_settings'],
    text: { utm_settings: META_STRICT_TEXT },
    maxBody: 8000,
    values: judgedBy({ business: digits('business'), permitted_tasks: listOf('permitted_tasks', META_CATALOG_TASKS), enabled_collab_terms: listOf('enabled_collab_terms', META_COLLAB_TERMS), utm_settings: utmSettings }),
    budget: false,
    ids: (params) => (DIGITS.test(params.get('business') ?? '') ? [{ id: params.get('business')!, kind: 'catalogagency' }] : []),
  },
  {
    // set-meta-catalog-access unshare: DELETE /{catalog}/agencies business — a partner the catalog is shared with now.
    name: 'catalog.agencies.unshare',
    method: 'DELETE',
    path: /^\d{1,20}\/agencies$/,
    kinds: ['catalog'],
    required: ['business'],
    optional: [],
    values: judgedBy({ business: digits('business') }),
    budget: false,
    ids: (params) => (DIGITS.test(params.get('business') ?? '') ? [{ id: params.get('business')!, kind: 'catalogpartner' }] : []),
  },
  {
    // set-meta-product-set create: POST /{catalog}/product_sets name [, filter, retailer_id, metadata, publish_to_shops].
    name: 'productset.create',
    method: 'POST',
    path: /^\d{1,20}\/product_sets$/,
    kinds: ['catalog'],
    required: ['name', 'filter'],
    optional: ['retailer_id', 'metadata', 'publish_to_shops'],
    text: SET_TEXT,
    maxBody: META_FILTER_BODY_MAX,
    values: judgedBy(setJudges()),
    budget: false,
    ids: shopIds,
  },
  {
    // set-meta-product-set change: POST /{product_set} — any of name, filter, retailer_id, metadata, publish_to_shops.
    name: 'productset.update',
    method: 'POST',
    path: CATALOG_PATH,
    kinds: ['productset'],
    required: [],
    optional: ['name', 'filter', 'retailer_id', 'metadata', 'publish_to_shops'],
    anyOf: ['name', 'filter', 'retailer_id', 'metadata', 'publish_to_shops'],
    text: SET_TEXT,
    maxBody: META_FILTER_BODY_MAX,
    values: judgedBy(setJudges()),
    budget: false,
    ids: shopIds,
  },
  {
    // remove-meta-catalog-items (explicit ask) and the undo of a set Nexus made: DELETE /{product_set}, no body.
    name: 'productset.delete',
    method: 'DELETE',
    path: CATALOG_PATH,
    kinds: ['productset'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // remove-meta-catalog-items with alsoLive (only when the person asked: the preview names what stops).
    name: 'productset.delete.live',
    method: 'DELETE',
    path: CATALOG_PATH,
    kinds: ['productset'],
    required: ['allow_live_product_set_deletion'],
    optional: [],
    maxBody: 200,
    values: judgedBy({ allow_live_product_set_deletion: exactly('true', 'allow_live_product_set_deletion') }),
    budget: false,
  },
  {
    // remove-meta-catalog-items (explicit ask) and the undo of a catalog Nexus made: DELETE /{catalog}, no body.
    name: 'catalog.delete',
    method: 'DELETE',
    path: CATALOG_PATH,
    kinds: ['catalog'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // remove-meta-catalog-items with alsoLive (only when the person asked: the preview names every set and ad set that stops).
    name: 'catalog.delete.live',
    method: 'DELETE',
    path: CATALOG_PATH,
    kinds: ['catalog'],
    required: ['allow_delete_catalog_with_live_product_set'],
    optional: [],
    maxBody: 200,
    values: judgedBy({ allow_delete_catalog_with_live_product_set: exactly('true', 'allow_delete_catalog_with_live_product_set') }),
    budget: false,
  },
  {
    // remove-meta-catalog-items items: POST /{catalog}/items_batch — DELETEs only, by retailer id (CT-045; D7: no field).
    name: 'catalog.items.delete',
    method: 'POST',
    path: /^\d{1,20}\/items_batch$/,
    kinds: ['catalog'],
    required: ['item_type', 'requests', 'allow_upsert'],
    optional: [],
    text: { requests: META_STRICT_TEXT },
    maxBody: 400_000,
    values: judgedBy({ item_type: exactly('PRODUCT_ITEM', 'item_type'), requests: deleteRequests, allow_upsert: exactly('false', 'allow_upsert') }),
    budget: false,
  },
  {
    // remove-meta-catalog-items item: DELETE /{product_item_id}, no body (CT-046; Meta's MCP ads_catalog_delete_product).
    name: 'productitem.delete',
    method: 'DELETE',
    path: CATALOG_PATH,
    kinds: ['productitem'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // remove-meta-catalog-items feed: DELETE /{product_feed_id}, no body — a supplementary feed of this business's catalog
    // (CT-079; the gateway checks the feed is in its catalog's feeds and supplementary: meta-catalog-owner.ts).
    name: 'productfeed.delete',
    method: 'DELETE',
    path: CATALOG_PATH,
    kinds: ['productfeed'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
]
