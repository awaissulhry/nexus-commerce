/**
 * Meta step 35 (2026-10-25) — the write allow-list entries of set-meta-catalog-items and set-meta-catalog-feed (and the
 * item-group delete of step 34's remove-meta-catalog-items): item writes, country / language overrides, an item group's
 * default item, feeds, their uploads, rules and upload schedules, an upload's error report. EXACT keys per edge and kind,
 * every value judged, JSON in one spelling only (as Nexus writes it) with every key allow-listed at every depth, a file Nexus
 * makes in memory (step 23's MetaWriteRule.file: Q8) judged column by column, text only where a person types it.
 *
 * D7 (binding; meta-catalog-items-owner.ts runs it again before anything goes): item writes (items_batch, localized items, a
 * group's default, a feed that brings items, a URL upload, a full file) only where step 12's writer check lets Nexus write
 * items; on a catalog Shopify writes, only an update-only upload of the D7 columns (id + internal_label, custom_label_0…4,
 * custom_number_0…4) to the Shopify feed or to Nexus's own supplementary feed, and feed rules on those columns.
 *
 * Checked 2026-10-25 (curl ≥ 3 s apart; developers.facebook.com/documentation/ads-commerce/…, .md; Meta's Python Business SDK
 * main, facebook_business/adobjects/{productitem,productgroup,productfeed,productfeedrule,productfeedupload}.py):
 *   - marketing-api/reference/product-catalog/items_batch: item_type [required] (PRODUCT_ITEM), requests [required] ≤ 5,000
 *     records {method CREATE | UPDATE | DELETE, data}, ≤ 28 MB; allow_upsert (default TRUE: an UPDATE of an unknown id makes
 *     it — Nexus always sends false); item_sub_type (enum, default EMPTY); answers {handles, validation_status}; 80014 = the
 *     catalog's batch limit. PRODUCT_ITEM fields (the "Supported Fields" table): required availability, brand, condition,
 *     description (≤ 5,000), id (≤ 100), image (≤ 21 {url, tag[]}), link, price ("<number> <ISO 4217>"), title (≤ 100);
 *     optional additional_variant_attribute ("Scent:Fruity,Flavor:Apple"), age_group, color (≤ 100), custom_label_0…4 (≤ 100),
 *     custom_number_0…4 (0–4294967295), disabled_capabilities, fb_product_category, gender, google_product_category (≤ 250),
 *     gtin (≤ 70), expiration_date, importer_address, importer_name, internal_label (≤ 5,000 labels of ≤ 110), item_group_id,
 *     material (≤ 200), mobile_link, mpn, origin_country, pattern (≤ 100), product_type (≤ 750), rating_count,
 *     rich_text_description (≤ 9,999), sale_price, sale_price_effective_date, shipping [{shipping_country, shipping_region,
 *     shipping_service, shipping_price_value, shipping_price_currency}], shipping_weight ("10 kg"), size, user_rating, video
 *     [{url, tag[]}]. `status` (active | archived) is in other item types' tables only (RECHECK CT-042: send it, LIVE-PROBE).
 *     quantity_to_sell_on_facebook (onsite checkout only, which Shops ads no longer use: CT-034) is never sent.
 *   - …/product-catalog/localized_items_batch: item_type, requests ≤ 5,000 {method, data{id,…}, localization{type LANGUAGE |
 *     COUNTRY | LANGUAGE_AND_COUNTRY, value (en_XX|US for both)}}; it "does not create new catalog items"; price, sale_price,
 *     unit_price, base_price, status and availability only in a COUNTRY override; a DELETE names only id (CT-103).
 *     catalog/guides/localized-catalog/supported-fields: title, description, availability, link, brand, price, sale_price,
 *     sale_price_effective_date, color, size, material, pattern, custom_label_0…4, short_description,
 *     additional_variant_attribute, image[0].url (applinks: all or none — not sent).
 *   - …/product-catalog/product_feeds "Creating": name, schedule (JSON), update_schedule, feed_type (PRODUCTS, OFFER,
 *     PRODUCT_RATINGS_AND_REVIEWS, LOCAL_INVENTORY, …), country (default US), default_currency (default USD), deletion_enabled
 *     (default TRUE; "Once enabled, we do not allow this field to be disabled" — always sent), delimiter, encoding,
 *     quoted_fields_mode, file_name, item_sub_type, migrated_from_feed_id, ingestion_source_type (PRIMARY_FEED |
 *     SUPPLEMENTARY_FEED; the SDK spells them lower case: LIVE-PROBE), primary_feed_ids, override_type (LANGUAGE, COUNTRY,
 *     LANGUAGE_AND_COUNTRY, …), override_value, rules (list<JSON-encoded string>: each rule its own JSON string),
 *     selected_override_fields → {id}. use_case is not sent.
 *   - …/product-feed "Updating": default_currency, deletion_enabled, delimiter, encoding, migrated_from_feed_id, name,
 *     quoted_fields_mode, schedule, update_schedule → {success}; country, feed_type, ingestion_source_type, override_type,
 *     primary_feed_ids are not updatable. "Deleting": DELETE /{feed}, no parameters (3964 = feed admin only; "effectively
 *     disables all ads using products that come from this feed").
 *   - docs/marketing-api/reference/product-feed-schedule: interval HOURLY | DAILY | WEEKLY | MONTHLY, interval_count, hour
 *     (0–23, Pacific unless timezone), minute (0–59), day_of_week (SUNDAY…SATURDAY), day_of_month, timezone, url, username
 *     (a password is Commerce Manager's: never sent by Nexus).
 *   - catalog/guides/feed-api "direct upload": POST /{feed}/uploads with url= or multipart file= (CSV / TSV / XML), optional
 *     update_only (true: creates and updates, never deletes; only id + the changed columns); username / password not sent.
 *     The uploads reference page says Creating "can't" — stale (RECHECK CT-088 CONFIRMED). commerce-platform/catalog/
 *     update-only-feed: the Shopify feed takes an update-only file; "if Shopify happens to update any of the fields you've
 *     included … the information will be overridden".
 *   - catalog/reference (feed formats): CSV header row, double-quoted fields with "" for a quote, nested values as JSON;
 *     internal_label as `['summer','trending']` (in CSV: "['summer','trending']"); images as image_link +
 *     additional_image_link (comma-separated); a full file needs id, title, description, availability, condition, price,
 *     link, image_link and one of brand / gtin / mpn.
 *   - …/product-feed/rules "Creating": attribute [required], rule_type [required] mapping_rule | value_mapping_rule |
 *     letter_case_rule | fallback_rule | regex_replace_rule, params (mapping_rule {"map_from"}, value_mapping_rule {old: new},
 *     letter_case_rule {"type": to_upper | to_lower | capitalize_all | capitalize_first}, fallback_rule
 *     {"user_default_value"}, regex_replace_rule {"regex"}) → {id}; one rule per rule_type + attribute. DELETE
 *     /{product_feed_rule_id}: SDK only (RECHECK CT-085), LIVE-PROBE; a rule's change is delete + create (CT-084).
 *   - …/product-feed/upload_schedules "Creating": upload_schedule (JSON) — an update-only recurring fetch; no update or delete.
 *   - catalog/guides/feed-api "error report": POST /{upload_session_id}/error_report, no parameters → {success}.
 *   - product group (SDK productgroup.py, node page 404): POST /{group} default_product_id (RECHECK CT-054: LIVE-PROBE);
 *     DELETE /{group} deletion_method DELETE_ITEMS | ONLY_IF_EMPTY (CT-055: always ONLY_IF_EMPTY unless asked, LIVE-PROBE).
 * No rule takes execution_options: Meta documents validate_only on none of these edges.
 *
 * Import rule (lane C4): only types from meta-calls.ts, the leaf text patterns and step 34's leaf-safe catalog helpers.
 */
import type { MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from './meta-write-text.js'
import { metaCatalogTextOk, metaHttpsUrlOk, META_RETAILER_ID_MAX, META_URL_MAX } from './meta-catalog-rules.js'

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null
type ValueJudge = (v: unknown) => string | null

// ── limits Nexus keeps (well inside Meta's) ─────────────────────────────────────────────────────────────────────────

/** Items in one request (Meta takes 5,000 and advises 3,000; a tool argument holds at most 250). */
export const MAX_ITEMS_PER_CHANGE = 250
/** Overrides in one request: each item's overrides are read first (one read each). */
export const MAX_OVERRIDES_PER_CHANGE = 50
/** Nexus's own cap on a batch's `requests` JSON (Meta: 28 MB). */
export const MAX_ITEMS_JSON_BYTES = 4 * 1024 * 1024
/** Nexus's own cap on an upload file it makes (rows of item fields or of D7 columns). */
export const MAX_FEED_FILE_BYTES = 4 * 1024 * 1024
/** Internal labels per item Nexus sends (Meta: 5,000) and their length (Meta: 110). */
export const MAX_INTERNAL_LABELS = 50
export const META_INTERNAL_LABEL_MAX = 110
export const META_CUSTOM_LABEL_MAX = 100
export const META_CUSTOM_NUMBER_MAX = 4_294_967_295
export const META_TITLE_MAX = 100
export const META_DESCRIPTION_MAX = 5000
export const META_RICH_TEXT_MAX = 9999
export const MAX_ITEM_IMAGES = 21
export const MAX_ITEM_VIDEOS = 20
export const MAX_MEDIA_TAGS = 10
export const MAX_SHIPPING_RULES = 20
export const MAX_VARIANT_ATTRIBUTES = 10
/** Feed rules in one change, value mappings in one rule (Nexus's own). */
export const MAX_FEED_RULES = 10
export const MAX_VALUE_MAPPINGS = 50
export const MAX_PRIMARY_FEEDS = 20
export const META_FEED_NAME_MAX = 100
/** The longest form body of an items request: the JSON at its cap, form-encoded (each byte at worst %XX), plus the rest. */
export const META_ITEMS_BODY_MAX = 3 * MAX_ITEMS_JSON_BYTES + 2000
export const META_FILE_BODY_MAX = 3 * MAX_FEED_FILE_BYTES + 2000

// ── the item fields Nexus writes (PRODUCT_ITEM) ─────────────────────────────────────────────────────────────────────

export const META_ITEM_AVAILABILITY = ['in stock', 'out of stock', 'available for order', 'discontinued'] as const
export const META_ITEM_CONDITIONS = ['new', 'refurbished', 'used'] as const
export const META_ITEM_GENDERS = ['female', 'male', 'unisex'] as const
export const META_ITEM_AGE_GROUPS = ['adult', 'infant', 'kids', 'newborn', 'toddler'] as const
export const META_ITEM_STATUSES = ['active', 'archived'] as const
/** disabled_capabilities (items_batch): the surfaces an item can be kept off — `da` is catalog ads. */
export const META_ITEM_CAPABILITIES = [
  'marketplace', 'b2c_marketplace', 'buy_on_facebook', 'cpas_parent_catalog', 'marketplace_shops', 'shops', 'daily_deals', 'ig_onsite_shopping',
  'ig_product_tagging', 'c2c_marketplace', 'groups', 'profile', 'da', 'whatsapp', 'ldp', 'mini_shops', 'business_inbox_in_messenger', 'neighborhoods',
] as const
export const META_ITEM_SUB_TYPES = [
  'APPLIANCES', 'BABY_FEEDING', 'BABY_TRANSPORT', 'BEAUTY', 'BEDDING', 'CAMERAS', 'CELL_PHONES_AND_SMART_WATCHES', 'CLEANING_SUPPLIES', 'CLOTHING',
  'CLOTHING_ACCESSORIES', 'COMPUTERS_AND_TABLETS', 'DIAPERING_AND_POTTY_TRAINING', 'ELECTRONICS_ACCESSORIES', 'FURNITURE', 'HEALTH', 'HOME_GOODS', 'JEWELRY',
  'NURSERY', 'PRINTERS_AND_SCANNERS', 'PROJECTORS', 'SHOES_AND_FOOTWEAR', 'SOFTWARE', 'TOYS', 'TVS_AND_MONITORS', 'VIDEO_GAME_CONSOLES_AND_VIDEO_GAMES', 'WATCHES',
] as const
export const META_WEIGHT_UNITS = ['lb', 'oz', 'g', 'kg'] as const
/** What a CREATE must carry (the table's required fields). */
export const META_ITEM_REQUIRED = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image', 'brand'] as const
/** The D7 columns (step 12's D7_NEXUS_COLUMNS, repeated here as the gateway's own allow-list; a test holds them equal). */
export const META_D7_COLUMNS = [
  'internal_label', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4',
  'custom_number_0', 'custom_number_1', 'custom_number_2', 'custom_number_3', 'custom_number_4',
] as const

const DIGITS = /^\d{1,20}$/
const META_ID = /^[1-9]\d{0,24}$/
const ISO2 = /^[A-Z]{2}$/
const ISO3 = /^[A-Z]{3}$/
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A JSON value written the one way Nexus writes it (JSON.stringify of what it parses to), or undefined. */
function canonicalJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Text of 1..max characters, no space at either end, no control or format character (META_STRICT_TEXT). */
const textOf = (what: string, max: number, pattern: RegExp = META_STRICT_TEXT): ValueJudge => (v) =>
  (metaCatalogTextOk(v, max, pattern) ? null : `${what} is 1 to ${max} characters of text, with no space at either end and no control or format character`)
const oneOf = (what: string, allowed: readonly string[]): ValueJudge => (v) => (typeof v === 'string' && allowed.includes(v) ? null : `${what} is one of ${allowed.join(', ')}`)
const httpsOf = (what: string): ValueJudge => (v) => (metaHttpsUrlOk(v) ? null : `${what} is an https address (at most ${META_URL_MAX} characters, no user or password)`)

/** Meta's price text: "<number> <ISO 4217>" with a period, no symbol ("49.90 EUR", "490 JPY"). */
export const META_PRICE_TEXT = /^(0|[1-9]\d{0,12})(\.\d{1,3})? [A-Z]{3}$/
const priceOf = (what: string): ValueJudge => (v) => (typeof v === 'string' && META_PRICE_TEXT.test(v) ? null : `${what} is "<amount> <currency>" with a period ("49.90 EUR")`)
/** A sale window: `2026-11-01T00:00+0100/2026-11-30T23:59+0100` (both ends, the start before the end). */
export const META_SALE_WINDOW = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{4})\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{4})$/
function saleWindowAt(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})([+-])(\d{2})(\d{2})$/.exec(v)
  if (!m) return null
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${m[6]}${m[7]}:${m[8]}`)
  return Number.isFinite(ms) ? ms : null
}
export function metaSaleWindowOk(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = META_SALE_WINDOW.exec(v)
  if (!m) return false
  const start = saleWindowAt(m[1])
  const end = saleWindowAt(m[2])
  return start !== null && end !== null && start < end
}
const saleWindow: ValueJudge = (v) => (metaSaleWindowOk(v) ? null : 'sale_price_effective_date is <start>/<end> as 2026-11-01T00:00+0100/2026-11-30T23:59+0100, the start before the end')
/** A real day YYYY-MM-DD. */
export function metaDayOk(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
const day = (what: string): ValueJudge => (v) => (metaDayOk(v) ? null : `${what} is a day as YYYY-MM-DD`)

/** An internal label: 1..110 printable ASCII characters, no quote, comma or bracket (a feed file lists them as ['a','b']). */
export function metaInternalLabelOk(v: unknown): v is string {
  return typeof v === 'string' && v === v.trim() && v.length >= 1 && v.length <= META_INTERNAL_LABEL_MAX && /^[\x20-\x7e]+$/.test(v) && !/['",[\]]/.test(v)
}
const internalLabels: ValueJudge = (v) => {
  if (!Array.isArray(v) || v.length > MAX_INTERNAL_LABELS) return `internal_label lists at most ${MAX_INTERNAL_LABELS} labels`
  if (!v.every(metaInternalLabelOk)) return `each internal label is 1 to ${META_INTERNAL_LABEL_MAX} plain characters (letters, digits, spaces and punctuation except quotes, commas and brackets), no space at either end`
  return new Set(v.map((l) => (l as string).toLowerCase())).size === v.length ? null : 'internal_label names each label once (Meta stores them in lower case)'
}
const customNumber = (what: string): ValueJudge => (v) => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= META_CUSTOM_NUMBER_MAX ? null : `${what} is a whole number from 0 to ${META_CUSTOM_NUMBER_MAX}`)

/** image / video: 1..max {url (https), tag[] (optional, each text ≤ 100)}. */
const mediaList = (what: string, max: number): ValueJudge => (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) return `${what} lists 1 to ${max} {url, tag}`
  const urls = new Set<string>()
  for (const m of v) {
    if (!plainObject(m) || !Object.keys(m).every((k) => k === 'url' || k === 'tag') || !('url' in m)) return `each ${what} is {"url": "https://…", "tag": [...]} and nothing else`
    if (!metaHttpsUrlOk(m.url)) return `each ${what}'s url is an https address`
    if (m.tag !== undefined && (!Array.isArray(m.tag) || m.tag.length > MAX_MEDIA_TAGS || !m.tag.every((t) => metaCatalogTextOk(t, 100)))) return `a ${what}'s tag lists at most ${MAX_MEDIA_TAGS} words of up to 100 characters`
    if (urls.has(m.url as string)) return `${what} names each address once`
    urls.add(m.url as string)
  }
  return null
}

/** Built by Nexus from name/value pairs: "Name:Value,Name:Value" (each 1..100, no ':' or ','), at most 10 pairs. */
export function metaVariantAttributesOk(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false
  const pairs = v.split(',')
  if (pairs.length > MAX_VARIANT_ATTRIBUTES) return false
  const names = new Set<string>()
  for (const pair of pairs) {
    const parts = pair.split(':')
    if (parts.length !== 2 || !parts.every((p) => metaCatalogTextOk(p, 100))) return false
    if (names.has(parts[0].toLowerCase())) return false
    names.add(parts[0].toLowerCase())
  }
  return true
}
const variantAttributes: ValueJudge = (v) => (metaVariantAttributesOk(v) ? null : `additional_variant_attribute is "Name:Value,Name:Value" (1 to ${MAX_VARIANT_ATTRIBUTES} pairs, each part 1 to 100 characters, no ':' or ',' inside, each name once)`)

const SHIPPING_KEYS = ['shipping_country', 'shipping_region', 'shipping_service', 'shipping_price_value', 'shipping_price_currency']
const shipping: ValueJudge = (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_SHIPPING_RULES) return `shipping lists 1 to ${MAX_SHIPPING_RULES} rules`
  for (const s of v) {
    if (!plainObject(s) || !Object.keys(s).every((k) => SHIPPING_KEYS.includes(k))) return `each shipping rule names only ${SHIPPING_KEYS.join(', ')}`
    if (typeof s.shipping_country !== 'string' || !ISO2.test(s.shipping_country)) return 'shipping_country is a two-letter country code'
    if (s.shipping_region !== undefined && !metaCatalogTextOk(s.shipping_region, 50)) return 'shipping_region is 1 to 50 characters'
    if (!metaCatalogTextOk(s.shipping_service, 100)) return 'shipping_service is 1 to 100 characters'
    if (typeof s.shipping_price_value !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,3})?$/.test(s.shipping_price_value)) return 'shipping_price_value is an amount with a period ("4.90")'
    if (typeof s.shipping_price_currency !== 'string' || !ISO3.test(s.shipping_price_currency)) return 'shipping_price_currency is a three-letter currency code'
  }
  return null
}
const ADDRESS_KEYS = ['street1', 'street2', 'city', 'region', 'postal_code', 'country']
const address: ValueJudge = (v) => {
  if (!plainObject(v) || !Object.keys(v).every((k) => ADDRESS_KEYS.includes(k))) return `importer_address names only ${ADDRESS_KEYS.join(', ')}`
  if (!metaCatalogTextOk(v.street1, 100) || !metaCatalogTextOk(v.city, 100)) return 'importer_address has street1 and city (1 to 100 characters each)'
  if (typeof v.country !== 'string' || !ISO2.test(v.country)) return 'importer_address.country is a two-letter country code'
  for (const k of ['street2', 'region', 'postal_code']) if (v[k] !== undefined && !metaCatalogTextOk(v[k], 100)) return `importer_address.${k} is 1 to 100 characters`
  return null
}

/** Every PRODUCT_ITEM field Nexus writes, with its judge (anything else in `data` is refused by name). */
export const META_ITEM_FIELD_JUDGES: Readonly<Record<string, ValueJudge>> = {
  id: textOf('id (the retailer id, the SKU)', META_RETAILER_ID_MAX),
  title: textOf('title', META_TITLE_MAX, META_NAME_TEXT),
  description: textOf('description', META_DESCRIPTION_MAX, META_NAME_TEXT),
  rich_text_description: textOf('rich_text_description', META_RICH_TEXT_MAX, META_NAME_TEXT),
  availability: oneOf('availability', META_ITEM_AVAILABILITY),
  condition: oneOf('condition', META_ITEM_CONDITIONS),
  price: priceOf('price'),
  sale_price: priceOf('sale_price'),
  sale_price_effective_date: saleWindow,
  link: httpsOf('link'),
  mobile_link: httpsOf('mobile_link'),
  image: mediaList('image', MAX_ITEM_IMAGES),
  video: mediaList('video', MAX_ITEM_VIDEOS),
  brand: textOf('brand', 100, META_NAME_TEXT),
  gtin: (v) => (typeof v === 'string' && /^\d{8,14}$/.test(v) ? null : 'gtin is 8 to 14 digits (UPC, EAN, JAN, ISBN), no dashes'),
  mpn: textOf('mpn', 70),
  google_product_category: textOf('google_product_category', 250),
  fb_product_category: textOf('fb_product_category', 250),
  product_type: textOf('product_type', 750, META_NAME_TEXT),
  item_group_id: textOf('item_group_id', META_RETAILER_ID_MAX),
  size: textOf('size', 100, META_NAME_TEXT),
  color: textOf('color', 100, META_NAME_TEXT),
  material: textOf('material', 200, META_NAME_TEXT),
  pattern: textOf('pattern', 100, META_NAME_TEXT),
  gender: oneOf('gender', META_ITEM_GENDERS),
  age_group: oneOf('age_group', META_ITEM_AGE_GROUPS),
  additional_variant_attribute: variantAttributes,
  internal_label: internalLabels,
  ...Object.fromEntries([0, 1, 2, 3, 4].map((n) => [`custom_label_${n}`, textOf(`custom_label_${n}`, META_CUSTOM_LABEL_MAX)])),
  ...Object.fromEntries([0, 1, 2, 3, 4].map((n) => [`custom_number_${n}`, customNumber(`custom_number_${n}`)])),
  disabled_capabilities: (v) => {
    if (!Array.isArray(v) || v.length > META_ITEM_CAPABILITIES.length || !v.every((c) => typeof c === 'string' && (META_ITEM_CAPABILITIES as readonly string[]).includes(c))) return `disabled_capabilities lists only ${META_ITEM_CAPABILITIES.join(', ')}`
    return new Set(v).size === v.length ? null : 'disabled_capabilities names each surface once'
  },
  status: oneOf('status', META_ITEM_STATUSES),
  expiration_date: day('expiration_date'),
  shipping,
  shipping_weight: (v) => (typeof v === 'string' && new RegExp(`^(0|[1-9]\\d{0,5})(\\.\\d{1,3})? (${META_WEIGHT_UNITS.join('|')})$`).test(v) ? null : 'shipping_weight is "<number> <lb | oz | g | kg>" ("10 kg")'),
  origin_country: (v) => (typeof v === 'string' && ISO2.test(v) ? null : 'origin_country is a two-letter country code'),
  importer_name: textOf('importer_name', 200, META_NAME_TEXT),
  importer_address: address,
  // items_batch "Supported Fields" (review B-F1): user_rating "Range between 1.0 and 5.0. One decimal place allowed. This
  // should be used in conjunction with rating_count"; rating_count "Must be greater than 0" — both or neither (below).
  user_rating: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5 && Math.round(v * 10) === v * 10 ? null : 'user_rating is a number from 1.0 to 5.0 with at most one decimal'),
  rating_count: (v) => (Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 1_000_000_000 ? null : 'rating_count is a whole number from 1'),
}
/** user_rating goes with rating_count (Meta: "used in conjunction"): both or neither. */
export const metaRatingPairProblem = (keys: readonly string[]): string | null => (keys.includes('user_rating') !== keys.includes('rating_count') ? 'user_rating and rating_count go together (Meta: a rating is used in conjunction with its count): both or neither' : null)
export const META_ITEM_WRITE_FIELDS: readonly string[] = Object.keys(META_ITEM_FIELD_JUDGES)

/** One item's `data`: id first, every key one Nexus writes, each judged; a CREATE carries every required field. */
export function metaItemDataProblem(data: unknown, verb: 'CREATE' | 'UPDATE', allowed: ReadonlySet<string> = new Set(META_ITEM_WRITE_FIELDS)): string | null {
  if (!plainObject(data)) return 'each request\'s data is an object of item fields'
  const keys = Object.keys(data)
  if (keys[0] !== 'id') return 'each request\'s data names the item\'s id first'
  for (const key of keys) {
    if (!allowed.has(key)) return `"${key.slice(0, 40)}" is not an item field Nexus writes here`
    const problem = META_ITEM_FIELD_JUDGES[key](data[key])
    if (problem) return `item ${typeof data.id === 'string' ? data.id.slice(0, 40) : '?'}: ${problem}`
  }
  const pair = metaRatingPairProblem(keys)
  if (pair) return `item ${typeof data.id === 'string' ? data.id.slice(0, 40) : '?'}: ${pair}`
  if (verb === 'CREATE') {
    const missing = META_ITEM_REQUIRED.filter((k) => !(k in data))
    if (missing.length) return `item ${String(data.id).slice(0, 40)}: a new item needs ${missing.join(', ')} (Meta's required fields)`
  } else if (keys.length < 2) return `item ${String(data.id).slice(0, 40)}: an update names at least one field besides id`
  return null
}

const jsonBytes = (value: string) => Buffer.byteLength(value, 'utf8')

/** items_batch `requests` of CREATE and UPDATE records (never DELETE: that is step 34's own rule), each judged. */
const itemRequests: Judge = (value) => {
  if (jsonBytes(value) > MAX_ITEMS_JSON_BYTES) return `requests is at most ${MAX_ITEMS_JSON_BYTES} bytes`
  const parsed = canonicalJson(value)
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_ITEMS_PER_CHANGE) return `requests is a JSON list (in Nexus's one spelling) of 1 to ${MAX_ITEMS_PER_CHANGE} item requests`
  const ids = new Set<string>()
  for (const r of parsed) {
    if (!plainObject(r) || Object.keys(r).join(',') !== 'method,data' || (r.method !== 'CREATE' && r.method !== 'UPDATE')) return 'each request is exactly {"method": "CREATE" | "UPDATE", "data": {…}} (a delete is remove-meta-catalog-items)'
    const problem = metaItemDataProblem(r.data, r.method)
    if (problem) return problem
    const id = (r.data as Record<string, unknown>).id as string
    if (ids.has(id)) return 'requests names each item once (Meta ignores every copy of a repeated id)'
    ids.add(id)
  }
  return null
}

// ── overrides (localized_items_batch) ───────────────────────────────────────────────────────────────────────────────

export type MetaOverrideType = 'COUNTRY' | 'LANGUAGE' | 'LANGUAGE_AND_COUNTRY'
export const META_OVERRIDE_TYPES: readonly MetaOverrideType[] = ['COUNTRY', 'LANGUAGE', 'LANGUAGE_AND_COUNTRY']
/** Fields an override carries: price, sale and availability only by country; text only by language (supported-fields). */
export const META_COUNTRY_OVERRIDE_FIELDS = ['price', 'sale_price', 'sale_price_effective_date', 'availability', 'link'] as const
export const META_LANGUAGE_OVERRIDE_FIELDS = [
  'title', 'description', 'link', 'brand', 'color', 'size', 'material', 'pattern', 'additional_variant_attribute', 'image',
  'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4',
] as const
/** short_description is a language field Meta lists for overrides only (≤ 1,000 by Nexus's own cap). */
const OVERRIDE_JUDGES: Readonly<Record<string, ValueJudge>> = { ...META_ITEM_FIELD_JUDGES, short_description: textOf('short_description', 1000, META_NAME_TEXT) }
export const overrideFieldsOf = (type: MetaOverrideType): readonly string[] => (type === 'COUNTRY' ? META_COUNTRY_OVERRIDE_FIELDS : [...META_LANGUAGE_OVERRIDE_FIELDS, 'short_description'])
/** The override's value: a country (IT), a language (it_IT, it_XX), or both (en_XX|CH). */
export function metaOverrideValueOk(type: MetaOverrideType, value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (type === 'COUNTRY') return ISO2.test(value)
  if (type === 'LANGUAGE') return /^[a-z]{2}_[A-Z]{2}$/.test(value)
  return /^[a-z]{2}_[A-Z]{2}\|[A-Z]{2}$/.test(value)
}
const overrideRequests: Judge = (value) => {
  if (jsonBytes(value) > MAX_ITEMS_JSON_BYTES) return `requests is at most ${MAX_ITEMS_JSON_BYTES} bytes`
  const parsed = canonicalJson(value)
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_OVERRIDES_PER_CHANGE * 3) return `requests is a JSON list (in Nexus's one spelling) of 1 to ${MAX_OVERRIDES_PER_CHANGE * 3} override requests`
  const seen = new Set<string>()
  for (const r of parsed) {
    if (!plainObject(r) || Object.keys(r).join(',') !== 'method,data,localization' || (r.method !== 'UPDATE' && r.method !== 'DELETE')) return 'each request is exactly {"method": "UPDATE" | "DELETE", "data": {…}, "localization": {…}}'
    const loc = r.localization
    if (!plainObject(loc) || Object.keys(loc).join(',') !== 'type,value' || !(META_OVERRIDE_TYPES as readonly string[]).includes(loc.type as string)) return 'localization is exactly {"type": "COUNTRY" | "LANGUAGE" | "LANGUAGE_AND_COUNTRY", "value": …}'
    const type = loc.type as MetaOverrideType
    if (!metaOverrideValueOk(type, loc.value)) return `a ${type} override's value is ${type === 'COUNTRY' ? 'a country (IT)' : type === 'LANGUAGE' ? 'a language (it_IT or it_XX)' : 'a language and a country (en_XX|CH)'}`
    const data = r.data
    if (!plainObject(data) || Object.keys(data)[0] !== 'id' || !metaCatalogTextOk(data.id, META_RETAILER_ID_MAX, META_STRICT_TEXT)) return 'each override\'s data names the item\'s id first'
    if (r.method === 'DELETE') {
      if (Object.keys(data).length !== 1) return 'an override\'s DELETE names only the item\'s id'
    } else {
      const allowed = new Set(['id', ...overrideFieldsOf(type)])
      if (Object.keys(data).length < 2) return 'an override names at least one field besides id'
      for (const [key, v] of Object.entries(data)) {
        if (!allowed.has(key)) return type === 'COUNTRY' ? `"${key.slice(0, 40)}" is not a country override field (Meta: ${META_COUNTRY_OVERRIDE_FIELDS.join(', ')})` : `"${key.slice(0, 40)}" is not a language override field (Meta: price, sale price and availability go only by country)`
        const problem = OVERRIDE_JUDGES[key](v)
        if (problem) return `item ${String(data.id).slice(0, 40)}: ${problem}`
      }
    }
    const key = `${data.id}|${type}|${loc.value}`
    if (seen.has(key)) return 'requests names each item\'s override once'
    seen.add(key)
  }
  return null
}

// ── feeds ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const META_FEED_INTERVALS = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'] as const
export const META_FEED_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const
export const META_FEED_DELIMITERS = ['AUTODETECT', 'BAR', 'COMMA', 'TAB', 'TILDE', 'SEMICOLON'] as const
export const META_FEED_ENCODINGS = ['AUTODETECT', 'LATIN1', 'UTF8', 'UTF16LE', 'UTF16BE', 'UTF32LE', 'UTF32BE'] as const
export const META_FEED_QUOTED = ['autodetect', 'on', 'off'] as const
/** The feed types Nexus makes (product_feeds feed_type): items, offers, ratings and reviews, local inventory. */
export const META_FEED_TYPES = ['PRODUCTS', 'OFFER', 'PRODUCT_RATINGS_AND_REVIEWS', 'LOCAL_INVENTORY'] as const
export const META_INGESTION_TYPES = ['PRIMARY_FEED', 'SUPPLEMENTARY_FEED'] as const
/** The override feeds Nexus makes (product_feeds override_type). */
export const META_FEED_OVERRIDE_TYPES = ['COUNTRY', 'LANGUAGE', 'LANGUAGE_AND_COUNTRY'] as const
/** A query key that looks like a secret: Nexus keeps every address it sends, so it sends none with a key in it. */
const SECRET_QUERY_KEY = /(token|key|secret|pass|pwd|sig|auth|credential|session)/i

/**
 * An address Meta fetches a file from (a feed schedule, a one-time upload): https, a public host (no IP literal, no
 * localhost, no internal name), no user or password, and no key-like query parameter (Nexus stores what it sends).
 */
export function metaPublicFetchUrlProblem(v: unknown): string | null {
  if (!metaHttpsUrlOk(v)) return `the file's address is an https address (at most ${META_URL_MAX} characters, no user or password)`
  const url = new URL(v)
  // Review A-N4: judged as a resolver reads it — lower case, trailing dots off (`localhost.` is localhost). The URL parser
  // already writes every IPv4 spelling (127.1, 0x7f000001, 2130706433) as dotted digits.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  const last = host.split('.').pop() ?? ''
  if (/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || !host.includes('.') || /^(\d+|0x[0-9a-f]+)$/.test(last)) return 'the file\'s address names a public host by its name (no IP address, no local name)'
  if (/(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|private|test|invalid|example|arpa|onion)$/.test(host) && !/(^|\.)example\.(com|org|net)$/.test(host)) return 'the file\'s address is on the public internet (Meta fetches it): not a local or internal host'
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEY.test(key)) return `the file's address carries "${key.slice(0, 30)}", which looks like a key or a password: Nexus keeps every address it sends, so give one without it (or set the feed up in Commerce Manager)`
  }
  return null
}

const SCHEDULE_KEYS = ['interval', 'url', 'interval_count', 'hour', 'minute', 'day_of_week', 'day_of_month', 'timezone']
/** A schedule (or update_schedule / upload_schedule): Meta's documented keys only, never a username or password. */
export function metaScheduleProblem(value: string, what = 'schedule'): string | null {
  const s = canonicalJson(value)
  if (!plainObject(s)) return `${what} is a JSON object in Nexus's one spelling`
  if (!Object.keys(s).every((k) => SCHEDULE_KEYS.includes(k))) return `${what} names only ${SCHEDULE_KEYS.join(', ')} (a password for the feed's host is set in Commerce Manager, never sent by Nexus)`
  if (!(META_FEED_INTERVALS as readonly string[]).includes(s.interval as string)) return `${what}.interval is ${META_FEED_INTERVALS.join(', ')} (Meta fetches at most once an hour)`
  const url = metaPublicFetchUrlProblem(s.url)
  if (url) return `${what}: ${url}`
  const int = (k: string, lo: number, hi: number) => s[k] === undefined || (Number.isSafeInteger(s[k]) && (s[k] as number) >= lo && (s[k] as number) <= hi)
  if (!int('interval_count', 1, 1000) || !int('hour', 0, 23) || !int('minute', 0, 59) || !int('day_of_month', 1, 31)) return `${what}: interval_count 1–1000, hour 0–23, minute 0–59, day_of_month 1–31 (whole numbers)`
  if (s.day_of_week !== undefined && !(META_FEED_DAYS as readonly string[]).includes(s.day_of_week as string)) return `${what}.day_of_week is ${META_FEED_DAYS.join(', ')}`
  if (s.day_of_week !== undefined && s.interval !== 'WEEKLY') return `${what}.day_of_week goes with a WEEKLY schedule only`
  if (s.day_of_month !== undefined && s.interval !== 'MONTHLY') return `${what}.day_of_month goes with a MONTHLY schedule only`
  if (s.timezone !== undefined && !(typeof s.timezone === 'string' && /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(s.timezone) && s.timezone.length <= 64)) return `${what}.timezone is a time zone name (Europe/Rome)`
  return null
}

const yesNo = (what: string): Judge => (v) => (v === 'true' || v === 'false' ? null : `${what} is true or false`)
const exactly = (want: string, what: string): Judge => (v) => (v === want ? null : `${what} is exactly ${want}`)
const enumOf = (what: string, allowed: readonly string[]): Judge => (v) => (allowed.includes(v) ? null : `${what} is one of ${allowed.join(', ')}`)
const feedName: Judge = (v) => (metaCatalogTextOk(v, META_FEED_NAME_MAX, META_NAME_TEXT) ? null : `name is 1 to ${META_FEED_NAME_MAX} characters of text, with no space at either end and no control or format character`)
const metaId = (what: string): Judge => (v) => (META_ID.test(v) ? null : `${what} is a Meta id (digits only)`)
const idList = (what: string, max: number): Judge => (v) => {
  const parsed = canonicalJson(v)
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > max || !parsed.every((x) => typeof x === 'string' && META_ID.test(x))) return `${what} is a JSON list of 1 to ${max} Meta ids (strings of digits)`
  return new Set(parsed).size === parsed.length ? null : `${what} names each id once`
}

/** Feed rules (CT-083 / CT-094): the attribute (an item field Nexus knows), the rule type and its documented params. */
export const META_FEED_RULE_TYPES = ['mapping_rule', 'value_mapping_rule', 'letter_case_rule', 'fallback_rule', 'regex_replace_rule'] as const
export type MetaFeedRuleType = typeof META_FEED_RULE_TYPES[number]
export const META_LETTER_CASES = ['to_upper', 'to_lower', 'capitalize_all', 'capitalize_first'] as const
/** The attributes a rule may name: the item fields Nexus writes plus the feed's own column names Meta maps (Meta's words). */
export const META_RULE_ATTRIBUTES: readonly string[] = [...META_ITEM_WRITE_FIELDS.filter((f) => f !== 'id'), 'short_description']
/** A column a mapping rule maps from: a column name of the file (letters, digits, _ . - and spaces). */
const COLUMN_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.\-[\]]{0,99}$/
/** A rule's params, by type, in Nexus's one spelling: every key allow-listed, every value text. */
export function metaRuleParamsProblem(type: string, params: unknown): string | null {
  if (!plainObject(params)) return 'a rule\'s params is a JSON object'
  const keys = Object.keys(params)
  switch (type) {
    case 'mapping_rule':
      return keys.join(',') === 'map_from' && typeof params.map_from === 'string' && COLUMN_NAME.test(params.map_from) ? null : 'a mapping_rule\'s params are exactly {"map_from": "<column of the file>"}'
    case 'value_mapping_rule':
      if (keys.length < 1 || keys.length > MAX_VALUE_MAPPINGS) return `a value_mapping_rule maps 1 to ${MAX_VALUE_MAPPINGS} values`
      return keys.every((k) => metaCatalogTextOk(k, 200) && metaCatalogTextOk(params[k], 200)) ? null : 'a value_mapping_rule maps each old value (1–200 characters) to a new one (1–200 characters)'
    case 'letter_case_rule':
      return keys.join(',') === 'type' && (META_LETTER_CASES as readonly string[]).includes(params.type as string) ? null : `a letter_case_rule's params are exactly {"type": ${META_LETTER_CASES.join(' | ')}}`
    case 'fallback_rule':
      return keys.join(',') === 'user_default_value' && metaCatalogTextOk(params.user_default_value, 500) ? null : 'a fallback_rule\'s params are exactly {"user_default_value": "<text, 1–500 characters>"}'
    case 'regex_replace_rule': {
      if (keys.join(',') !== 'regex' || typeof params.regex !== 'string' || !params.regex || params.regex.length > 200 || !/^[\x20-\x7e]+$/.test(params.regex)) return 'a regex_replace_rule\'s params are exactly {"regex": "<a pattern, 1–200 plain characters>"} (Meta documents no other key)'
      try { new RegExp(params.regex) } catch { return 'regex is not a valid regular expression' }
      return null
    }
  }
  return `rule_type is ${META_FEED_RULE_TYPES.join(', ')}`
}
const ruleParams: Judge = (v, params) => {
  const parsed = canonicalJson(v)
  return parsed === undefined ? 'params is JSON in Nexus\'s one spelling' : metaRuleParamsProblem(params.get('rule_type') ?? '', parsed)
}
const ruleAttribute: Judge = (v) => (META_RULE_ATTRIBUTES.includes(v) ? null : 'attribute is an item field Nexus knows (title, price, custom_label_0, …)')
/**
 * `rules` at a feed's create (review B-F2): product_feeds "Creating" types it list<JSON-encoded string> (SDK
 * create_product_feed `'rules': 'list<string>'`), so it is a JSON list of 1..10 STRINGS, each a rule {attribute, rule_type,
 * params} as JSON in Nexus's one spelling. The rules, or null when it is not that.
 */
export function metaFeedCreateRules(v: string): Array<Record<string, unknown>> | null {
  const parsed = canonicalJson(v)
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_FEED_RULES || !parsed.every((r) => typeof r === 'string')) return null
  const rules = parsed.map((r) => canonicalJson(r as string))
  return rules.every(plainObject) ? rules as Array<Record<string, unknown>> : null
}
const feedRules: Judge = (v) => {
  const parsed = metaFeedCreateRules(v)
  if (!parsed) return `rules is a JSON list of 1 to ${MAX_FEED_RULES} rules, each a JSON-encoded string {"attribute", "rule_type", "params"} (Meta: list<JSON-encoded string>)`
  const seen = new Set<string>()
  for (const r of parsed) {
    if (Object.keys(r).join(',') !== 'attribute,rule_type,params') return 'each rule is exactly {"attribute", "rule_type", "params"}'
    if (!META_RULE_ATTRIBUTES.includes(r.attribute as string)) return 'a rule\'s attribute is an item field Nexus knows'
    const problem = metaRuleParamsProblem(r.rule_type as string, r.params)
    if (problem) return problem
    const key = `${r.rule_type}|${r.attribute}`
    if (seen.has(key)) return 'Meta takes one rule per rule type and attribute'
    seen.add(key)
  }
  return null
}

// ── a file Nexus makes (Q8) ─────────────────────────────────────────────────────────────────────────────────────────

/** The upload's file part (step 23's MetaWriteRule.file): its text under `file`, its name under `file_name_part`. */
export const FEED_FILE = { key: 'file', nameKey: 'file_part_name', filename: 'nexus-items.csv', contentType: 'text/csv' } as const

/** One CSV cell as RFC 4180 writes it: always double-quoted, a quote doubled. */
export const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`

/** Parse a CSV Nexus wrote (every cell quoted, "" for a quote, \n between rows): rows of cells, or null. */
export function parseNexusCsv(text: string): string[][] | null {
  const rows: string[][] = []
  let i = 0
  while (i < text.length) {
    const row: string[] = []
    for (;;) {
      if (text[i] !== '"') return null
      let cell = ''
      i++
      for (;;) {
        if (i >= text.length) return null
        if (text[i] === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue }
          i++
          break
        }
        cell += text[i++]
      }
      row.push(cell)
      if (text[i] === ',') { i++; continue }
      if (text[i] === '\n' || i >= text.length) { i++; break }
      return null
    }
    rows.push(row)
  }
  return rows
}

/** internal_label in a feed file: `['a','b']` (catalog/reference). */
export const internalLabelsCell = (labels: readonly string[]) => `[${labels.map((l) => `'${l}'`).join(',')}]`
function labelsOfCell(cell: string): string[] | null {
  if (cell === '' || cell === '[]') return []
  const m = /^\[('[^']*'(?:,'[^']*')*)\]$/.exec(cell)
  return m ? m[1].split(',').map((l) => l.slice(1, -1)) : null
}

/**
 * The columns an upload file has, from its header (for the D7 check, the gateway's too), or null when it is not a file
 * Nexus wrote.
 */
export function metaFeedFileColumns(text: string): string[] | null {
  const rows = parseNexusCsv(text)
  return rows && rows.length ? rows[0] : null
}

/**
 * Review B-F4 — a file's images: catalog/reference names `image_link` (the main image, required in a full file) and
 * `additional_image_link` ("URLs for up to 50 additional images of your item, separated by a comma", ≤ 2,000 characters);
 * JSON `image` is items_batch's form. A file Nexus makes writes image[0] as image_link and the rest, comma-separated, as
 * additional_image_link (an address with a comma in it is refused: the comma would split it).
 */
export const META_ADDITIONAL_IMAGE_LINK_MAX = 2000
const additionalImageLinks: ValueJudge = (v) => {
  if (typeof v !== 'string' || !v || v.length > META_ADDITIONAL_IMAGE_LINK_MAX) return `additional_image_link is 1 to ${MAX_ITEM_IMAGES - 1} https addresses separated by commas (at most ${META_ADDITIONAL_IMAGE_LINK_MAX} characters)`
  const urls = v.split(',')
  if (urls.length > MAX_ITEM_IMAGES - 1 || !urls.every((u) => metaHttpsUrlOk(u))) return `additional_image_link is 1 to ${MAX_ITEM_IMAGES - 1} https addresses separated by commas (no space, no comma inside an address)`
  return new Set(urls).size === urls.length ? null : 'additional_image_link names each address once'
}
/** What a FULL file must carry (catalog/reference: "products may not upload" without them), and one of brand / gtin / mpn. */
export const META_FILE_REQUIRED = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link'] as const
export const META_FILE_ONE_OF = ['brand', 'gtin', 'mpn'] as const
const FILE_JUDGES: Readonly<Record<string, ValueJudge>> = { ...OVERRIDE_JUDGES, image_link: httpsOf('image_link'), additional_image_link: additionalImageLinks }

/** A cell's value as the field's judge reads it (JSON for lists and objects, numbers for numbers). */
function cellValue(column: string, cell: string): unknown {
  if (column === 'internal_label') return labelsOfCell(cell)
  if (/^custom_number_[0-4]$/.test(column) || column === 'rating_count' || column === 'user_rating') return cell === '' ? '' : /^\d+(\.\d+)?$/.test(cell) ? Number(cell) : cell
  if (['image', 'video', 'shipping', 'importer_address', 'disabled_capabilities'].includes(column)) {
    try { return JSON.parse(cell) } catch { return cell }
  }
  return cell
}

/**
 * A feed file Nexus made: CSV in its own spelling, a header of distinct allow-listed columns (`id` first), 1..250 rows, each
 * cell judged as its field. Empty cells by the kind of file (Meta's docs do not say what an empty cell does in an update):
 *   'labels'  an update-only D7 file: an empty cell only where the person asked to empty that column (LIVE-PROBES CT35-03);
 *   'update'  an update-only file of items: no empty cell (every row names the same fields);
 *   'full'    a full replace: Meta's required columns are present and filled in every row; any other may be empty (none).
 */
export type MetaFeedFileKind = 'labels' | 'update' | 'full'
export function metaFeedFileProblem(text: string, columns: ReadonlySet<string>, kind: MetaFeedFileKind): string | null {
  const rows = parseNexusCsv(text)
  if (!rows || rows.length < 2) return 'the file is a CSV Nexus wrote: a header and 1 or more rows, every cell in double quotes'
  const [header, ...body] = rows
  if (header[0] !== 'id') return 'the file\'s first column is id (the retailer id)'
  if (new Set(header).size !== header.length) return 'the file names each column once'
  const unknown = header.find((c) => !columns.has(c))
  if (unknown) return `"${unknown.slice(0, 40)}" is not a column this upload may carry`
  if (header.length < 2) return 'the file carries at least one column besides id'
  const pair = metaRatingPairProblem(header)
  if (pair) return pair
  if (kind === 'full') {
    const missing = META_FILE_REQUIRED.filter((c) => !header.includes(c))
    if (missing.length) return `a full file carries Meta's required columns: ${missing.join(', ')} missing`
    if (!META_FILE_ONE_OF.some((c) => header.includes(c))) return `a full file carries one of ${META_FILE_ONE_OF.join(', ')} (Meta needs at least one)`
  }
  if (body.length > MAX_ITEMS_PER_CHANGE) return `the file carries at most ${MAX_ITEMS_PER_CHANGE} rows`
  const ids = new Set<string>()
  for (const row of body) {
    if (row.length !== header.length) return 'every row has a cell for every column'
    const [id] = row
    if (!metaCatalogTextOk(id, META_RETAILER_ID_MAX, META_STRICT_TEXT)) return `each row's id is the item's retailer id (1 to ${META_RETAILER_ID_MAX} characters)`
    if (ids.has(id)) return 'the file names each item once'
    ids.add(id)
    if (kind === 'full' && !META_FILE_ONE_OF.some((c) => header.includes(c) && row[header.indexOf(c)] !== '')) return `item ${id.slice(0, 40)}: one of ${META_FILE_ONE_OF.join(', ')} is filled (Meta needs at least one)`
    for (let c = 1; c < header.length; c++) {
      const column = header[c]
      if (row[c] === '') {
        if (kind === 'update') return `item ${id.slice(0, 40)}: an empty ${column} (an update-only file of items names the same filled fields in every row)`
        if (kind === 'full' && (META_FILE_REQUIRED as readonly string[]).includes(column)) return `item ${id.slice(0, 40)}: ${column} is required and empty`
        continue
      }
      const judge = FILE_JUDGES[column]
      const problem = judge ? judge(cellValue(column, row[c])) : `"${column}" has no judge`
      if (problem) return `item ${id.slice(0, 40)}: ${problem}`
    }
  }
  return null
}

/** The columns of an update-only D7 file (the Shopify feed's or Nexus's own supplementary feed's). */
export const META_D7_FILE_COLUMNS: ReadonlySet<string> = new Set(['id', ...META_D7_COLUMNS])
/** The columns of a full or update-only file of a feed Nexus writes items in (images as image_link + additional_image_link). */
export const META_ITEM_FILE_COLUMNS: ReadonlySet<string> = new Set([...META_ITEM_WRITE_FIELDS.filter((f) => f !== 'image'), 'image_link', 'additional_image_link'])

const uploadFile: MetaWriteRule['file'] = {
  key: FEED_FILE.key, nameKey: FEED_FILE.nameKey, name: /^nexus-(items|labels)\.csv$/, contentType: FEED_FILE.contentType, maxBytes: MAX_FEED_FILE_BYTES,
  // The D7 check of which columns this upload may carry is the owner's (meta-catalog-items-owner.ts: it knows the feed and
  // the catalog's writer); here every column is one Nexus writes and every cell is judged.
  judge: (text) => metaFeedFileProblem(text, META_ITEM_FILE_COLUMNS, 'labels'),
}

// ── the rules ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ID_PATH = /^\d{1,20}$/
/** Each key's judge, then the body's own rule (any key without a judge is refused). */
const judgedBy = (judges: Record<string, Judge>, also?: (params: Params) => string | null) => (params: Params): string | null => {
  for (const [key, value] of params) {
    const judge = judges[key]
    if (!judge) return `${key} is not a key of this change`
    const problem = judge(value, params)
    if (problem) return problem
  }
  return also ? also(params) : null
}

const FEED_CREATE_JUDGES: Record<string, Judge> = {
  name: feedName,
  feed_type: enumOf('feed_type', META_FEED_TYPES),
  ingestion_source_type: enumOf('ingestion_source_type', META_INGESTION_TYPES),
  primary_feed_ids: idList('primary_feed_ids', MAX_PRIMARY_FEEDS),
  override_type: enumOf('override_type', META_FEED_OVERRIDE_TYPES),
  schedule: (v) => metaScheduleProblem(v, 'schedule'),
  update_schedule: (v) => metaScheduleProblem(v, 'update_schedule'),
  country: (v) => (ISO2.test(v) ? null : 'country is a two-letter country code'),
  default_currency: (v) => (ISO3.test(v) ? null : 'default_currency is a three-letter currency code'),
  deletion_enabled: yesNo('deletion_enabled'),
  delimiter: enumOf('delimiter', META_FEED_DELIMITERS),
  encoding: enumOf('encoding', META_FEED_ENCODINGS),
  quoted_fields_mode: enumOf('quoted_fields_mode', META_FEED_QUOTED),
  item_sub_type: enumOf('item_sub_type', META_ITEM_SUB_TYPES),
  migrated_from_feed_id: metaId('migrated_from_feed_id'),
  rules: feedRules,
}
const FEED_CREATE_KEYS = ['name', 'feed_type', 'ingestion_source_type', 'deletion_enabled', 'primary_feed_ids', 'override_type', 'schedule', 'update_schedule', 'country', 'default_currency', 'delimiter', 'encoding', 'quoted_fields_mode', 'item_sub_type', 'migrated_from_feed_id', 'rules']

/** The body of a feed's create, as a whole: a supplementary feed names its primaries and fetches nothing on a schedule. */
function feedCreateProblem(params: Params): string | null {
  const supplementary = params.get('ingestion_source_type') === 'SUPPLEMENTARY_FEED'
  if (supplementary) {
    if (!params.has('primary_feed_ids')) return 'a supplementary feed names the primary feeds it adds fields to (primary_feed_ids: Meta requires them)'
    for (const k of ['feed_type', 'override_type', 'migrated_from_feed_id', 'item_sub_type', 'deletion_enabled', 'schedule']) if (params.has(k)) return `a supplementary feed takes no ${k} (it only adds fields to items its primary feeds bring)`
    // Review A-F1 (D7): a supplementary feed's rules shape the values it adds to the primary source's (Shopify's) items, so
    // they name the D7 columns only — never price, title or another field the primary source writes.
    const rules = params.has('rules') ? metaFeedCreateRules(params.get('rules') ?? '') ?? [] : []
    const foreign = rules.map((r) => String(r.attribute)).filter((a) => !(META_D7_COLUMNS as readonly string[]).includes(a))
    if (foreign.length) return `a supplementary feed's rules name the D7 columns only (${META_D7_COLUMNS.join(', ')}): not ${[...new Set(foreign)].join(', ')}`
  } else {
    if (params.has('primary_feed_ids')) return 'primary_feed_ids go only with a supplementary feed'
    // Review rule (CT-077): deletion_enabled is ONE-WAY and defaults to true — always sent, so the person decides it.
    if (!params.has('deletion_enabled')) return 'deletion_enabled is always sent with a feed that brings items (Meta\'s default is true, and once on it can never be turned off)'
    if (params.has('override_type') && params.has('feed_type')) return 'an override (country or language) feed takes no feed_type'
    if (params.has('override_type') && params.get('deletion_enabled') !== 'false') return 'an override feed is made with deletion_enabled false'
    if (params.has('migrated_from_feed_id') && params.has('override_type')) return 'migrated_from_feed_id goes with a feed that brings items, not with an override feed'
  }
  return null
}

const FEED_UPDATE_KEYS = ['name', 'schedule', 'update_schedule', 'default_currency', 'delimiter', 'encoding', 'quoted_fields_mode', 'migrated_from_feed_id', 'deletion_enabled']

/** Step 35's rules on the write allow-list (meta-calls.ts writeRules). */
export const META_CATALOG_ITEMS_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // set-meta-catalog-items create / update (CT-030–039, CT-041–044, CT-052): POST /{catalog}/items_batch, CREATE and
    // UPDATE records only, allow_upsert ALWAYS false (an UPDATE never makes an item), on a catalog Nexus may write items in.
    name: 'catalog.items.write', method: 'POST', path: /^\d{1,20}\/items_batch$/, kinds: ['catalogitems'],
    required: ['item_type', 'requests', 'allow_upsert'], optional: ['item_sub_type'], maxBody: META_ITEMS_BODY_MAX, edgeCall: true, bulky: true,
    text: { requests: META_NAME_TEXT },
    values: judgedBy({ item_type: exactly('PRODUCT_ITEM', 'item_type'), requests: itemRequests, allow_upsert: exactly('false', 'allow_upsert'), item_sub_type: enumOf('item_sub_type', META_ITEM_SUB_TYPES) }),
    budget: false,
  },
  {
    // set-meta-catalog-items overrides / remove-overrides (CT-100–103): POST /{catalog}/localized_items_batch.
    name: 'catalog.items.localize', method: 'POST', path: /^\d{1,20}\/localized_items_batch$/, kinds: ['catalogitems'],
    required: ['item_type', 'requests'], optional: [], maxBody: META_ITEMS_BODY_MAX, edgeCall: true, bulky: true,
    text: { requests: META_NAME_TEXT },
    values: judgedBy({ item_type: exactly('PRODUCT_ITEM', 'item_type'), requests: overrideRequests }),
    budget: false,
  },
  {
    // set-meta-catalog-items group-default (CT-054, SDK only): POST /{product_group_id} default_product_id.
    name: 'productgroup.default', method: 'POST', path: ID_PATH, kinds: ['productgroup'],
    required: ['default_product_id'], optional: [], values: judgedBy({ default_product_id: metaId('default_product_id') }), budget: false,
  },
  {
    // remove-meta-catalog-items kind item-group (CT-055, SDK only): DELETE /{product_group_id} deletion_method, ALWAYS sent
    // (ONLY_IF_EMPTY unless the person asked for the items to go too).
    name: 'productgroup.delete', method: 'DELETE', path: ID_PATH, kinds: ['productgroup'],
    required: ['deletion_method'], optional: [], maxBody: 200, values: judgedBy({ deletion_method: enumOf('deletion_method', ['ONLY_IF_EMPTY', 'DELETE_ITEMS']) }), budget: false,
  },
  {
    // set-meta-catalog-feed create (CT-074, CT-078, CT-092, CT-094, CT-096, CT-097, CT-099, CT-104): POST /{catalog}/product_feeds.
    name: 'catalog.feed.create', method: 'POST', path: /^\d{1,20}\/product_feeds$/, kinds: ['catalogfeeds'],
    required: ['name'], optional: FEED_CREATE_KEYS.filter((k) => k !== 'name'), maxBody: 700_000, edgeCall: true,
    text: { name: META_NAME_TEXT, rules: META_STRICT_TEXT },
    values: judgedBy(FEED_CREATE_JUDGES, feedCreateProblem),
    budget: false,
  },
  {
    // set-meta-catalog-feed change (CT-075, CT-076, CT-077): POST /{feed}; deletion_enabled only to true (one-way).
    name: 'catalog.feed.update', method: 'POST', path: ID_PATH, kinds: ['catalogfeed'],
    required: [], optional: FEED_UPDATE_KEYS, anyOf: FEED_UPDATE_KEYS, maxBody: 8000,
    text: { name: META_NAME_TEXT },
    values: judgedBy({ ...Object.fromEntries(FEED_UPDATE_KEYS.map((k) => [k, FEED_CREATE_JUDGES[k]])), deletion_enabled: exactly('true', 'deletion_enabled (Meta never turns it off again, so Nexus only turns it on)') }),
    budget: false,
  },
  {
    // the undo of a feed Nexus made (its own record names it): DELETE /{feed}, no body.
    name: 'catalog.feed.delete.made', method: 'DELETE', path: ID_PATH, kinds: ['catalogfeed'],
    required: [], optional: [], values: () => null, budget: false,
  },
  {
    // set-meta-catalog-feed labels / upload with a file Nexus makes (CT-089, CT-090, CT-191): POST /{feed}/uploads, multipart.
    name: 'catalog.feed.upload.file', method: 'POST', path: /^\d{1,20}\/uploads$/, kinds: ['catalogfeed'],
    required: [FEED_FILE.key, FEED_FILE.nameKey, 'update_only'], optional: [], maxBody: META_FILE_BODY_MAX, edgeCall: true, bulky: true,
    file: uploadFile,
    values: judgedBy({ [FEED_FILE.key]: () => null, [FEED_FILE.nameKey]: () => null, update_only: yesNo('update_only') }, (params) => {
      const text = params.get(FEED_FILE.key) ?? ''
      const name = params.get(FEED_FILE.nameKey) ?? ''
      if (name !== 'nexus-labels.csv' && name !== 'nexus-items.csv') return `${FEED_FILE.nameKey} is not a file name this change sends (nexus-labels.csv or nexus-items.csv)`
      // A D7 labels file (nexus-labels.csv) is always update-only and carries the D7 columns only: it never replaces the
      // feed's items and never writes a field Shopify sends.
      if (name === 'nexus-labels.csv') {
        if (params.get('update_only') !== 'true') return 'a labels file is uploaded update-only (it never replaces the feed\'s items)'
        return metaFeedFileProblem(text, META_D7_FILE_COLUMNS, 'labels')
      }
      // A file of items: a full replace carries Meta's required columns; an update-only one no empty cell.
      return metaFeedFileProblem(text, META_ITEM_FILE_COLUMNS, params.get('update_only') === 'false' ? 'full' : 'update')
    }),
    budget: false,
  },
  {
    // set-meta-catalog-feed upload from an address (CT-088): POST /{feed}/uploads url [, update_only].
    name: 'catalog.feed.upload.url', method: 'POST', path: /^\d{1,20}\/uploads$/, kinds: ['catalogfeed'],
    required: ['url', 'update_only'], optional: [], maxBody: 3 * META_URL_MAX + 200, edgeCall: true,
    values: judgedBy({ url: (v) => metaPublicFetchUrlProblem(v), update_only: yesNo('update_only') }),
    budget: false,
  },
  {
    // set-meta-catalog-feed rules add (CT-083, the create half of CT-084): POST /{feed}/rules attribute, rule_type, params.
    name: 'catalog.feed.rule.create', method: 'POST', path: /^\d{1,20}\/rules$/, kinds: ['catalogfeed'],
    required: ['attribute', 'rule_type', 'params'], optional: [], maxBody: 70_000, edgeCall: true,
    text: { params: META_STRICT_TEXT },
    values: judgedBy({ attribute: ruleAttribute, rule_type: enumOf('rule_type', META_FEED_RULE_TYPES), params: ruleParams }),
    budget: false,
  },
  {
    // set-meta-catalog-feed rules remove (CT-085, the delete half of CT-084; SDK only): DELETE /{rule}, no body.
    name: 'catalog.feed.rule.delete', method: 'DELETE', path: ID_PATH, kinds: ['feedrule'],
    required: [], optional: [], values: () => null, budget: false,
  },
  {
    // set-meta-catalog-feed upload-schedule (CT-081): POST /{feed}/upload_schedules upload_schedule (an update-only fetch).
    name: 'catalog.feed.uploadSchedule', method: 'POST', path: /^\d{1,20}\/upload_schedules$/, kinds: ['catalogfeed'],
    required: ['upload_schedule'], optional: [], maxBody: 8000, edgeCall: true,
    values: judgedBy({ upload_schedule: (v) => metaScheduleProblem(v, 'upload_schedule') }),
    budget: false,
  },
  {
    // set-meta-catalog-feed error-report (CT-087): POST /{upload}/error_report, no body (Meta makes the full report file).
    name: 'catalog.feed.errorReport', method: 'POST', path: /^\d{1,20}\/error_report$/, kinds: ['feedupload'],
    required: [], optional: [], emptyBody: true, values: () => null, budget: false,
  },
]

// ── the item reads that carry internal labels (meta-calls.ts lets `tags` through only with exactly these lists) ─────────

const LABEL_FIELDS = ['custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4', 'custom_number_0', 'custom_number_1', 'custom_number_2', 'custom_number_3', 'custom_number_4']
/**
 * An item as a change reads it first, in Meta's READ names (SDK productitem.py: name = title, url = link,
 * manufacturer_part_number = mpn, retailer_product_group_id = item_group_id, capabilities_disabled_by_user =
 * disabled_capabilities, tags = internal_label, shipping_weight_value / _unit, sale_price_start_date / _end_date).
 */
export const META_ITEM_STATE_FIELDS = [
  'id', 'retailer_id', 'name', 'description', 'rich_text_description', 'availability', 'condition', 'price', 'sale_price', 'currency',
  'sale_price_start_date', 'sale_price_end_date', 'url', 'mobile_link', 'image_url', 'additional_image_urls', 'brand', 'gtin',
  'manufacturer_part_number', 'fb_product_category', 'product_type', 'retailer_product_group_id', 'size', 'color', 'material', 'pattern',
  'gender', 'age_group', 'additional_variant_attributes', ...LABEL_FIELDS, 'capabilities_disabled_by_user', 'visibility', 'expiration_date',
  'shipping_weight_value', 'shipping_weight_unit', 'origin_country', 'importer_name', 'importer_address', 'tags',
].join(',')
/** The D7 columns of an item as a labels upload reads them first. */
export const META_ITEM_D7_FIELDS = ['id', 'retailer_id', 'tags', ...LABEL_FIELDS].join(',')
/** The exact field lists with which a read of `<id>/products` may name `tags` (an item's internal labels). */
export const META_ITEM_READ_FIELDS_WITH_LABELS: ReadonlySet<string> = new Set([META_ITEM_STATE_FIELDS, META_ITEM_D7_FIELDS])

/** The D7 key column and columns an update-only labels file may carry (a test holds them equal to step 12's). */
export const META_D7_KEY_COLUMN = 'id'
export { DIGITS as META_DIGITS_PATTERN }
