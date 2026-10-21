/**
 * Meta ads step 13 (2026-10-21) — product sets, commerce accounts and shops, and Instagram product tags, read LIVE from
 * Meta through the gateway (GET only). Nothing here stores anything; a caller never names a Graph field or path (fixed
 * field lists per node type), and a product-set filter is built by Nexus from typed conditions (productSetFilter), never
 * taken as a caller's JSON. Lane C4's set writes (steps 34, 35) reuse, never copy: setConditionArg (THE zod schema of one
 * condition), assertPriceFilterAllowed (a price condition only for a person who may see revenue), productSetFilter with
 * { maxBytes: MAX_SET_FILTER_WRITE_BYTES, everyItem: false } (everyItem is REQUIRED: no condition = rule null = EVERY
 * item, so a write passes true only when the request says "every item" explicitly; conditions that match every item
 * anyway — price_amount gte 0, availability is_any of all four — make an all-items set too, so C4's preview compares
 * matchingItems with the catalog's product_count and says "matches every item"), setFilterPriceAmount (Meta's price × 100)
 * and setFilterOut (a rule in words, a priced one only under the restricted key).
 *
 * WHICH objects a business may read (one rule each, all reused, none copied):
 *   - product sets, their items, a filter preview and facets: only of a catalog step 12's readableCatalog allows (the
 *     chosen ad account's business portfolio owns it, or it is a client catalog whose owner no other Nexus business uses,
 *     and the portfolio is not shared with another Nexus business); a set id is checked by step 12's catalogChild
 *     (`product_set`: its own product_catalog) BEFORE it is read;
 *   - commerce accounts (shops' "commerce merchant settings"), shops, set-up status, checkout countries: only the chosen
 *     Facebook Page's (`/{page}/commerce_merchant_settings`, `/{page}/shop_setup_status`) and the chosen ad account's
 *     business portfolio's (`/{portfolio}/commerce_merchant_settings`) — the portfolio's only when no other Nexus business
 *     uses that portfolio (step 10's portfolioTaken), and an account whose Page another Nexus business uses is its id and
 *     the flag only; a caller's commerce-account id must be in those lists, a shop id in such an account's shops;
 *   - Instagram product tags: only the chosen Instagram account (step 10's instagramOf) and its own media (step 10's
 *     ownMedia, the owner check); the catalogs it may tag from and the catalog a product search runs in pass
 *     readableCatalog; a product whose appeal is read must be an item of a readable catalog (catalogChild `item`).
 * Pages and Instagram accounts another business in Nexus uses appear as `{ id, takenByAnotherBusiness: true }` only.
 *
 * Money: items of a set carry prices — step 12's itemRow / itemMoney (minor units of the item's currency, Meta's own text,
 * all restricted keys); a product tag's price strings go through itemMoney too; a set filter that names a price is
 * answered only under the restricted key filterWithPricesShown. Meta's product-set price filter (`price_amount`,
 * `sale_price_amount`) is "the price multiplied by 100, for all currencies" — setFilterPriceAmount converts minor units.
 *
 * Checked 2026-10-21 (curl, ≥3 s apart; developers.facebook.com/documentation/ads-commerce/…/<page>.md, Meta's Python
 * Business SDK main facebook_business/adobjects/<node>.py, and facebook-business-sdk-codegen api_specs):
 *   - product-catalog/product_sets: GET params ancestor_id, has_children, parent_id (0 = root sets), retailer_id; summary
 *     total_count; error 80009 (too many calls to this catalog). product-set (node): id, auto_creation_url, filter (string),
 *     latest_metadata, live_metadata ("passed integrity review"), name, product_catalog, product_count, retailer_id; SDK and
 *     codegen only: ordering_info (meaning undocumented — RECHECK-C4 CT-067; read as it is). ProductSetMetadata (SDK):
 *     cover_image_url, description, external_url, integrity_review_status. Filter rules on the same page: fields (product
 *     items: retailer_id, retailer_product_group_id, name, brand, category, product_type, color, size, material, pattern,
 *     custom_label_0…4, tags, availability, condition, gender, age_group, price_amount and sale_price_amount = price × 100
 *     "for all currencies"), operators eq, neq, contains, not_contains, i_contains (in the examples), is_any, is_not_any,
 *     lt, lte, gt, gte, starts_with ("now only available for the product category field"), and, or; "contains … only for
 *     string matching … for enum values use eq"; "You can't use non-English Unicode characters for filters in labels"; an
 *     empty result set means ads on it "will not deliver"; filter ≤ 500 KiB; error 10803 = a set with the same filter
 *     exists. `internal_label` as a filter field is on no page (the item field is; its old name is product_tags, and the
 *     filter list has `tags`) — offered, Meta's answer decides (LIVE-PROBES CT-063b).
 *   - product-set/products: params bulk_pagination, error_priority, error_type, filter ("JSON-encoded WCA rule"); summary
 *     total_count. product-catalog/products: the same filter (the preview, CT-063).
 *   - product-catalog/facets: params facets ("A JSON-encoded Product Facet Request" — its shape is on no page and not in
 *     the SDK or codegen) and filter; ProductCatalogFacets (SDK): facets list<map<string, list<Object>>>, item_count.
 *     Nexus sends facets as a list of field names from a fixed list (LIVE-PROBES CT-903).
 *   - business/commerce_merchant_settings (no params, read only); page/commerce_merchant_settings and the
 *     CommerceMerchantSettings node fields checkout_config, contact_email, display_name, facebook_channel,
 *     instagram_channel, korea_ftc_listing, merchant_page (Profile), merchant_status (ENABLED | EXTERNALLY_DISABLED),
 *     offsite_iab_checkout_enabled_countries (list<string>), payment_provider, privacy_policy_localized,
 *     shops_ads_setup, terms (SDK commercemerchantsettings.py, page.py); Meta's Commerce Merchant Settings API guide
 *     (catalog/guides/commerce-merchant-settings-api.md): basic fields id, display_name, merchant_status, contact_email,
 *     terms; policy fields need `locale`, config fields (checkout_config, cta, shops_ads_setup) need `country_code`
 *     (`shops_ads_setup.country_code(KR)`); edges product_catalogs, setup_status, shops ("requires catalog management
 *     permission"), and others not read here (orders, payouts, tax, shipping: not this step's).
 *   - commerce-platform/catalog/commerce-merchant-settings.md (CMS shops: optional `filter`, fb_sales_channel /
 *     ig_sales_channel with status, fb_page / ig_user; only configured channels appear) and commerce-platform/catalog/
 *     shop.md (GET /{shop_id}: fb_sales_channel {status ENABLED | DISABLED | STAGING, fb_page}, ig_sales_channel {status,
 *     ig_user}); SDK shop.py also shop_status, commerce_merchant_settings, workspace.
 *   - graph-api/reference/page/shop_setup_status (v26: "Shows the setup status for the given page shop", New Pages
 *     Experience supported, no params, error 200) and CMS setup_status (SDK); CommerceMerchantSettingsSetupStatus (SDK):
 *     deals_setup, marketplace_approval_status, marketplace_approval_status_details, payment_setup, review_status,
 *     shop_setup.
 *   - instagram-platform/instagram-api-with-facebook-login/product-tagging.md: GET /{ig-user}?fields=
 *     shopping_product_tag_eligibility (true = linked to an approved Instagram Shop); shopping_review_status is SDK only
 *     (iguser.py); /{ig-user}/available_catalogs (catalog_id, catalog_name, shop_name, product_count; collaborative
 *     catalogs not supported); /{ig-user}/catalog_product_search (catalog_id REQUIRED, q = name or SKU; image_url,
 *     is_checkout_flow, merchant_id, product_id, product_name, retailer_id, review_status approved | outdated | pending |
 *     rejected, product_variants {product_id, variant_name}; cursor paging); /{ig-media}/product_tags (product_id,
 *     merchant_id, name, price_string, image_url, review_status, is_checkout, stripped_price_string, x, y; the guide's
 *     "string_sale_price_string" is SDK stripped_sale_price_string, product_url is SDK only); /{ig-user}/product_appeal
 *     (product_id; IGShoppingProductAppeal: eligible_for_appeal, product_appeal_status, product_id, rejection_reasons,
 *     review_status); /{ig-media}/children for carousel slides. Limits: no tags on Stories or Live, none for Creator
 *     accounts, 25 tagged posts per 24 h; since 2023-08-10 businesses without checkout-enabled Shops may lose tagging.
 *   - instagram-graph-api/reference/ig-media/product_tags.md (review B3): GET "Stories, Instagram TV, Reels, Live, and
 *     Mentions are not supported" (POST: Stories, IGTV, Live, Mentions; 20 tags on a feed post, 30 on a Reel);
 *     ig-user/product_appeal.md (review B1): GET answers eligible_for_appeal, product_id, review_status (the SDK adds
 *     product_appeal_status, rejection_reasons); both need an admin role on the business portfolio that owns the Shop,
 *     catalog_management, instagram_basic, instagram_shopping_tag_products, and ads_read / ads_management when the role
 *     on the Page comes through Business Manager (review B4).
 *   - round 2: ig-user/available_catalogs.md, ig-user/catalog_product_search.md, ig-user/product_appeal.md name "one of
 *     ads_management, ads_read" with the Business Manager role, ig-media/product_tags.md ads_read and ads_management (B2);
 *     their examples send product_id / merchant_id unquoted and the SDK types them int — exactId keeps them exact or null (B1).
 *   - catalog/guides/commerce-merchant-settings-api.md: privacy_policy_localized `locale` "follows BCP 47 format" (B6).
 *   - shop.md (review B2, round 3): documents fb_sales_channel and ig_sales_channel only (status, fb_page / ig_user; no
 *     sub-field selection, its sample has no Page / account id); shop_status and workspace are SDK only (api_specs Shop.json
 *     types both channels Object); SDK commercemerchantsettings.py types checkout_config as a string.
 */
import { z } from 'zod'
import { FIELDS } from '@nexus/shared/permissions'
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { readGroups, type FieldGroup } from './live-objects.js'
import { fieldRefused, listPaged, listWithFallback, oneWithFallback, part } from './paging.js'
import { instagramOf, ownMedia, PAGE_TOKEN_NOTE, tidy } from './live-media.js'
import {
  CATALOG_NO_OWNER, CATALOG_OF_ANOTHER_BUSINESS, catalogChild, catalogPortfolio, need, readableCatalog, type ReadableCatalog,
} from './catalog-rule.js'
import { ITEM_LIST_FIELDS, itemMoney, itemRow, PRICE_NOTE, withNote } from './live-catalog.js'
import { currencyExponent } from './money.js'
import {
  META_ITEM_ERROR_TYPE_SET, META_SET_ENUM_OPS, META_SET_FILTER_ENUMS, META_SET_FILTER_MAX_BYTES, META_SET_FILTER_OPS, META_SET_FILTER_PRICE_FIELDS, META_SET_FILTER_TEXT_FIELDS,
  META_SET_LABEL_FIELD, META_SET_LIST_OPS, META_SET_MAX_VALUE_CHARS, META_SET_MAX_VALUES, META_SET_PRICE_OPS, META_SET_TEXT_OPS,
} from '../../meta/meta-catalog-lists.js'
import { portfolioTaken, takenIds } from './taken.js'

type Row = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter((s): s is string => !!s) : [])
const clampRows = (n: number | undefined, dflt: number) => Math.min(500, Math.max(1, Math.trunc(n ?? dflt)))

/**
 * Round 2 B1 / round 3 — Meta may send an id as a JSON NUMBER (the Instagram shopping edges do: Meta's examples unquoted;
 * SDK igshoppingproductappeal.py, shadowigmediaproducttags.py, shadowigusercatalogproductsearch.py: int), and the gateway's
 * JSON.parse keeps a number exactly only below 2^53. A number id that is not a safe integer has lost digits: null and
 * counted (never a wrong id), as step 9 does for location clusters. Every id this file reads from Meta's answers goes
 * through it (ids, owner and taken checks too).
 */
interface IdCount { notExact: number }
function exactId(v: unknown, count: IdCount): string | null {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) { count.notExact++; return null }
  return metaObjectId(v)
}
export const IDS_NOT_EXACT = 'Meta sent some ids as numbers too long to keep exactly, so they are null here (never a wrong id). A product: find it by name or SKU (meta-instagram-product-tags view search, meta-catalog-items) or in Commerce Manager.'
const idsNote = (count: IdCount) => (count.notExact ? { idsNotExact: count.notExact, idsNote: IDS_NOT_EXACT } : {})

// ── product-set filters: built by Nexus from typed conditions (lane C4's writes reuse this) ──────────────────────────

/**
 * Text fields of a product item a set may test (Meta's product-set filter fields). `internal_label` is on no Meta page —
 * the documented field is `tags` — and stays behind LIVE-PROBES CT-063b: Meta may answer it with an error or with a silent
 * 0 matches (a set that never delivers), so an answer that uses it says so.
 */
// Step 34 — the lists live in services/meta/meta-catalog-lists.ts (a leaf the gateway's write judge reuses), unchanged.
const SET_FILTER_TEXT_FIELDS = META_SET_FILTER_TEXT_FIELDS
/** Fields with Meta's fixed values (product items), tested with eq / neq / is_any / is_not_any only. */
const SET_FILTER_ENUMS = META_SET_FILTER_ENUMS
/** Price fields: Meta's number is the price × 100 in every currency (setFilterPriceAmount). */
const SET_FILTER_PRICE_FIELDS = META_SET_FILTER_PRICE_FIELDS
const SET_FILTER_FIELDS = [...SET_FILTER_TEXT_FIELDS, 'availability', 'condition', 'gender', 'age_group', ...SET_FILTER_PRICE_FIELDS] as const
type SetFilterField = typeof SET_FILTER_FIELDS[number]
const SET_FILTER_OPS = META_SET_FILTER_OPS
type SetFilterOp = typeof SET_FILTER_OPS[number]
export const SET_MATCH = ['all', 'any'] as const
/** Fields a facets read may count (no price: a facet of prices would be money). */
export const SET_FACET_FIELDS = [
  'brand', 'product_type', 'category', 'availability', 'condition', 'color', 'size', 'material', 'pattern', 'gender', 'age_group',
  'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4',
] as const
export const MAX_SET_CONDITIONS = 20
const MAX_SET_VALUES = META_SET_MAX_VALUES
const MAX_SET_VALUE_CHARS = META_SET_MAX_VALUE_CHARS
/** At most this many bytes of encoded rule on a read (preview, items, facets): a read never needs a big filter. */
const MAX_SET_FILTER_READ_BYTES = 8 * 1024
/** Meta's cap on a set's filter ("max length: 500 KiB"): lane C4's set writes pass it as maxBytes. */
export const MAX_SET_FILTER_WRITE_BYTES = META_SET_FILTER_MAX_BYTES

const lowerArg = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
/**
 * THE schema of one condition: the read tools and lane C4's set writes validate with exactly this (productSetFilter
 * checks the same again at run time, in words, for a caller that did not go through it).
 */
export const setConditionArg = z.object({
  field: z.preprocess(lowerArg, z.enum(SET_FILTER_FIELDS)).describe(`the item field: ${SET_FILTER_FIELDS.join(' | ')} (price_amount, sale_price_amount: a price; internal_label is on no Meta page — 0 matches may mean "not known", prefer tags)`),
  op: z.preprocess(lowerArg, z.enum(SET_FILTER_OPS)).describe('eq | neq | contains | not_contains | i_contains | is_any | is_not_any | starts_with (category only) | lt | lte | gt | gte (prices)'),
  value: z.string().max(MAX_SET_VALUE_CHARS).optional().describe('the one value (eq, neq, contains, not_contains, i_contains, starts_with)'),
  values: z.array(z.string().max(MAX_SET_VALUE_CHARS)).max(MAX_SET_VALUES).optional().describe('the values (is_any, is_not_any)'),
  amountMinor: z.number().int().min(0).max(1_000_000_000).optional().describe('a price condition: minor units of currency (4990 = 49.90); only for a person who may see revenue'),
})

const TEXT_OPS = META_SET_TEXT_OPS
const ENUM_OPS = META_SET_ENUM_OPS
const PRICE_OPS = META_SET_PRICE_OPS
const LIST_OPS = META_SET_LIST_OPS
const PRICE_FIELDS: ReadonlySet<string> = new Set(SET_FILTER_PRICE_FIELDS)
const LABEL_FIELD = META_SET_LABEL_FIELD
const PLAIN_ASCII = /^[\x20-\x7e]+$/

export interface SetCondition { field: SetFilterField; op: SetFilterOp; value?: string | null; values?: string[] | null; amountMinor?: number | null }
export interface SetFilterInput { conditions?: SetCondition[] | null; match?: 'all' | 'any' | null; currency?: string | null }
/**
 * maxBytes: the encoded rule's cap (reads MAX_SET_FILTER_READ_BYTES, the default; a set write MAX_SET_FILTER_WRITE_BYTES).
 * everyItem (REQUIRED, review A-F1): may no condition mean "every item of the catalog" (rule null)? The reads pass true (no
 * filter); a set WRITE passes false unless the request said so explicitly — then no condition is refused instead of
 * quietly making an all-items set. Anything but true refuses an empty list.
 */
export interface SetFilterOptions { maxBytes?: number; everyItem: boolean }

/** Who may filter by price: a price condition's counts and members give prices away (~30 previews = the exact price). */
export const PRICE_FILTER_REFUSED = 'A price condition (price_amount, sale_price_amount) is only for a person who may see revenue in Nexus: counting the items under a price gives the prices away. Filter on other fields, or ask a person who may see revenue.'
type FieldGate = (permission: (typeof FIELDS)[keyof typeof FIELDS]) => boolean
/** May this caller send price conditions? (revenue view or the whole financial view — as the money keys are stripped). */
function mayFilterByPrice(can: FieldGate): boolean {
  return can(FIELDS.financialsRevenueView) || can(FIELDS.financialsView)
}
/** Refuses (in words) any price condition from a caller who may not see revenue — before any call. Lane C4 reuses it. */
export function assertPriceFilterAllowed(conditions: unknown, can: FieldGate): void {
  const priced = Array.isArray(conditions) && conditions.some((c) => PRICE_FIELDS.has(String(obj(c)?.field ?? '').trim().toLowerCase()))
  if (priced && !mayFilterByPrice(can)) throw new MetaLiveRefusal(PRICE_FILTER_REFUSED)
}

/**
 * Meta's product-set price filter value: "the price multiplied by 100, for all currencies" (EUR 49.90 → 4990, JPY 490 →
 * 49000), from minor units of `currency`. Null when it is not a whole hundredth (a currency with three decimals) or not a
 * whole, non-negative amount. The ONE helper for this unit (lane C4's set writes use it too).
 */
export function setFilterPriceAmount(minor: number, currency: string): number | null {
  if (!Number.isSafeInteger(minor) || minor < 0) return null
  const exp = currencyExponent(currency)
  if (exp <= 2) {
    const amount = minor * 10 ** (2 - exp)
    return Number.isSafeInteger(amount) ? amount : null
  }
  const per = 10 ** (exp - 2)
  return minor % per === 0 ? minor / per : null
}

const OP_HINT: Readonly<Record<'text' | 'enum' | 'price', string>> = {
  text: 'a text field takes eq, neq, contains, not_contains, i_contains, is_any, is_not_any (and starts_with on category only)',
  enum: 'this field has Meta\'s fixed values: it takes eq, neq, is_any or is_not_any (Meta: contains is for text only)',
  price: 'a price takes eq, neq, lt, lte, gt or gte',
}

/**
 * THE product-set filter Nexus sends (a preview here; lane C4's set writes): one rule per condition, joined with `and`
 * (match all, the default) or `or` (match any). Every field, operator, value and value TYPE is checked against Meta's
 * documented rules at run time (a refusal in words, never a TypeError); a price is minor units of `currency` (default:
 * the ad account's), sent as Meta's price × 100; the encoded rule is capped (options.maxBytes). No condition = rule null
 * = every item of the catalog — refused unless options.everyItem is true. Price permission is assertPriceFilterAllowed's,
 * checked by the caller before this.
 */
export function productSetFilter(input: SetFilterInput, defaultCurrency: string | null, options: SetFilterOptions): { rule: Row | null; priceCurrency: string | null } {
  const maxBytes = options?.maxBytes ?? MAX_SET_FILTER_READ_BYTES
  const raw: unknown = input.conditions
  if (raw !== null && raw !== undefined && !Array.isArray(raw)) throw new MetaLiveRefusal('conditions is a list of conditions (field, op, value / values / amountMinor).')
  const conditions: unknown[] = Array.isArray(raw) ? raw : []
  if (conditions.length > MAX_SET_CONDITIONS) throw new MetaLiveRefusal(`At most ${MAX_SET_CONDITIONS} conditions in one filter.`)
  const match: unknown = input.match
  if (match !== null && match !== undefined && match !== 'all' && match !== 'any') throw new MetaLiveRefusal('match is all (every condition) or any (one of them).')
  if (input.currency !== null && input.currency !== undefined && typeof input.currency !== 'string') throw new MetaLiveRefusal('currency is a currency code (e.g. EUR).')
  if (conditions.length === 0 && options?.everyItem !== true) throw new MetaLiveRefusal('No condition means every item of the catalog: say so explicitly (every item), or give the conditions.')
  let priceCurrency: string | null = null
  const parts = conditions.map((given, i): Row => {
    const c = obj(given)
    if (!c) throw new MetaLiveRefusal(`Condition ${i + 1} is not a condition (field, op, value / values / amountMinor).`)
    const field = typeof c.field === 'string' ? c.field.trim().toLowerCase() : ''
    const op = typeof c.op === 'string' ? c.op.trim().toLowerCase() : ''
    const at = `Condition ${i + 1} (${field || '?'} ${op || '?'})`
    if (!(SET_FILTER_FIELDS as readonly string[]).includes(field)) throw new MetaLiveRefusal(`${at}: Nexus filters only on ${SET_FILTER_FIELDS.join(', ')}.`)
    if (!(SET_FILTER_OPS as readonly string[]).includes(op)) throw new MetaLiveRefusal(`${at}: the operator is one of ${SET_FILTER_OPS.join(', ')}.`)
    const given1 = c.value
    const givenN = c.values
    const amountMinor = c.amountMinor
    if (given1 !== null && given1 !== undefined && typeof given1 !== 'string') throw new MetaLiveRefusal(`${at}: value is text.`)
    if (givenN !== null && givenN !== undefined && !Array.isArray(givenN)) throw new MetaLiveRefusal(`${at}: values is a list of texts.`)
    // Bounded before any work on it (a caller that did not go through setConditionArg may send any length).
    if (Array.isArray(givenN) && givenN.length > MAX_SET_VALUES) throw new MetaLiveRefusal(`${at}: at most ${MAX_SET_VALUES} values.`)
    if (Array.isArray(givenN) && givenN.some((v) => typeof v !== 'string')) throw new MetaLiveRefusal(`${at}: values is a list of texts.`)
    if (amountMinor !== null && amountMinor !== undefined && typeof amountMinor !== 'number') throw new MetaLiveRefusal(`${at}: amountMinor is a whole number (minor units).`)
    const value = given1 as string | null | undefined
    const values = givenN as string[] | null | undefined
    const kind = PRICE_FIELDS.has(field) ? 'price' : field in SET_FILTER_ENUMS ? 'enum' : 'text'
    if (!(kind === 'price' ? PRICE_OPS : kind === 'enum' ? ENUM_OPS : TEXT_OPS).has(op)) throw new MetaLiveRefusal(`${at}: ${OP_HINT[kind]}.`)
    if (op === 'starts_with' && field !== 'category') throw new MetaLiveRefusal(`${at}: Meta allows starts_with on category only now; use contains.`)
    if (kind === 'price') {
      if (typeof amountMinor !== 'number' || value || values?.length) throw new MetaLiveRefusal(`${at}: give the price as amountMinor only (minor units of the currency: 4990 = 49.90).`)
      const currency = (input.currency ?? defaultCurrency ?? '').trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) throw new MetaLiveRefusal(`${at}: name the currency of the price (currency, e.g. EUR).`)
      const amount = setFilterPriceAmount(amountMinor, currency)
      if (amount === null) throw new MetaLiveRefusal(`${at}: Meta compares prices in hundredths of the currency; ${amountMinor} is not a whole, non-negative hundredth in ${currency}.`)
      priceCurrency = currency
      return { [field]: { [op]: amount } }
    }
    if (amountMinor !== null && amountMinor !== undefined) throw new MetaLiveRefusal(`${at}: amountMinor is for price_amount or sale_price_amount only.`)
    const list = LIST_OPS.has(op)
    if (list ? !!value : !!values?.length) throw new MetaLiveRefusal(`${at}: ${list ? `${op} takes a list (values)` : `${op} takes one value (value); is_any / is_not_any take a list (values)`}.`)
    const texts = [...new Set((list ? values ?? [] : value ? [value] : []).map((v) => v.trim()).filter(Boolean))]
    if (!texts.length) throw new MetaLiveRefusal(`${at}: give ${list ? 'values' : 'value'}.`)
    if (texts.length > MAX_SET_VALUES) throw new MetaLiveRefusal(`${at}: at most ${MAX_SET_VALUES} values.`)
    for (const v of texts) {
      if (v.length > MAX_SET_VALUE_CHARS) throw new MetaLiveRefusal(`${at}: a value is at most ${MAX_SET_VALUE_CHARS} characters.`)
      if (/[\u0000-\u001f\u007f]/.test(v)) throw new MetaLiveRefusal(`${at}: a value holds no control characters.`)
      if (LABEL_FIELD.test(field) && !PLAIN_ASCII.test(v)) throw new MetaLiveRefusal(`${at}: Meta takes no non-English characters in a label filter ("${v}").`)
      if (kind === 'enum' && !SET_FILTER_ENUMS[field as keyof typeof SET_FILTER_ENUMS].includes(v.toLowerCase())) {
        throw new MetaLiveRefusal(`${at}: "${v}" is not one of Meta's values (${SET_FILTER_ENUMS[field as keyof typeof SET_FILTER_ENUMS].join(', ')}).`)
      }
    }
    const sent = kind === 'enum' ? texts.map((v) => v.toLowerCase()) : texts
    return { [field]: { [op]: list ? sent : sent[0] } }
  })
  const rule = parts.length === 0 ? null : parts.length === 1 ? parts[0] : { [match === 'any' ? 'or' : 'and']: parts }
  // The ENCODED size: the rule's JSON text in UTF-8 bytes, what Meta's "max length: 500 KiB" on a set's filter counts.
  const bytes = rule ? Buffer.byteLength(JSON.stringify(rule), 'utf8') : 0
  if (bytes > maxBytes) throw new MetaLiveRefusal(`The filter is ${bytes} bytes once encoded; at most ${maxBytes} here. Use fewer or shorter values.`)
  return { rule, priceCurrency }
}

/** Does a rule name internal_label (on no Meta page: LIVE-PROBES CT-063b)? */
const usesInternalLabel = (rule: unknown) => !!rule && /"internal_label"/.test(JSON.stringify(rule))
export const INTERNAL_LABEL_NOTE = 'internal_label as a set filter field is on no Meta page (the documented field is tags): Meta may refuse it, or answer 0 matches without an error — a set built on it would then never deliver. Until LIVE-PROBES CT-063b settles it, read 0 matches here as "not known", and prefer tags.'

const PRICE_KEY = /^(sale_)?price(_amount)?$|^base_price(_amount)?$/i
const OP_WORDS: Readonly<Record<string, string>> = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: 'does not contain', i_contains: 'contains (any case)', is_any: 'is one of',
  is_not_any: 'is none of', starts_with: 'starts with', lt: '<', lte: '≤', gt: '>', gte: '≥',
}

/** Does a rule name a price anywhere (a price key at any depth, or "price" anywhere in its text)? */
function rulePrices(rule: unknown, depth = 0): boolean {
  if (depth === 0 && /price/i.test(JSON.stringify(rule) ?? '')) return true
  if (depth > 10) return true
  if (Array.isArray(rule)) return rule.some((r) => rulePrices(r, depth + 1))
  const r = obj(rule)
  return !!r && Object.entries(r).some(([k, v]) => PRICE_KEY.test(k) || rulePrices(v, depth + 1))
}

/** A rule in plain words ("brand is "Shop A" and availability is one of "in stock""), or null for a shape Nexus does not know. */
export function setFilterWords(rule: unknown, depth = 0): string | null {
  const r = obj(rule)
  if (!r || depth > 8) return null
  if (Object.keys(r).length === 0) return depth === 0 ? 'every item of the catalog' : null
  const quote = (v: unknown) => (typeof v === 'string' ? `"${v}"` : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null)
  const parts: string[] = []
  for (const [key, value] of Object.entries(r)) {
    if ((key === 'and' || key === 'or') && Array.isArray(value)) {
      const inner = value.map((x) => setFilterWords(x, depth + 1))
      if (!inner.length || inner.some((x) => x === null)) return null
      parts.push(inner.length === 1 ? inner[0]! : `(${inner.join(` ${key} `)})`)
      continue
    }
    const condition = obj(value)
    if (!condition) return null
    for (const [op, v] of Object.entries(condition)) {
      const shown = Array.isArray(v) ? v.map(quote) : [quote(v)]
      if (shown.some((s) => s === null)) return null
      parts.push(`${key} ${OP_WORDS[op] ?? op} ${shown.join(', ')}`)
    }
  }
  const words = parts.join(' and ')
  return depth === 0 && words.startsWith('(') && words.endsWith(')') && parts.length === 1 ? words.slice(1, -1) : words
}

export const SET_PRICE_UNIT = 'price_amount and sale_price_amount are Meta\'s price × 100 in every currency (4990 = 49.90 EUR, 49000 = 490 JPY), not minor units.'

/**
 * A set's filter for an answer: Meta's string parsed, in plain words. A filter that names a price is answered ONLY
 * under filterWithPricesShown (a restricted key: financials.revenue.view), with Meta's ×100 unit said next to the words.
 */
export function setFilterOut(value: unknown): Row {
  const raw = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : JSON.stringify(value)
  let rule: unknown = raw === '' ? {} : null
  if (typeof value === 'object' && value !== null) rule = value
  else if (raw !== '') { try { rule = JSON.parse(raw) } catch { rule = null } }
  const priced = /price/i.test(raw) || (rule !== null && rulePrices(rule))
  const shown = rule === null ? raw : rule
  const words = rule === null ? null : setFilterWords(rule)
  if (priced) return { filter: null, filterHasPrices: true, filterWithPricesShown: { rule: shown, words, unit: SET_PRICE_UNIT } }
  return { filter: shown, filterWords: words, filterHasPrices: false }
}

// ── meta-product-sets ─────────────────────────────────────────────────────────────────────────────────────────────

export const PRODUCT_SET_VIEWS = ['list', 'set', 'items', 'preview', 'facets'] as const
export const SET_ERROR_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const

const SET_LIST_FIELDS = 'id,name,retailer_id,product_count,filter'
const SET_DETAIL_CORE = `${SET_LIST_FIELDS},auto_creation_url,latest_metadata,live_metadata,product_catalog{id}`
const SET_DETAIL_MORE = 'ordering_info'
export const EMPTY_SET = 'This set holds no items: ads on it will not deliver (Meta).'
const PREVIEW_NOTE = 'Meta has no check (validate_only) for a product-set change: this read is the preview — how many items a set with this filter would hold, and a sample. Nexus builds the rule from the conditions (a caller never sends Meta JSON). A price filter compares Meta\'s number only (the price × 100, whatever each item\'s currency).'

function setRow(r: Row) {
  const count = num(r.product_count)
  return {
    productSetId: exactId(r.id, { notExact: 0 }), name: text(r.name), retailerId: text(r.retailer_id), productCount: count, ...setFilterOut(r.filter),
    ...(count === 0 ? { warning: EMPTY_SET } : {}),
  }
}

/** A facets answer without any facet of prices (Meta's own choice could add one; prices are money). */
function facetsSafe(value: unknown, depth = 0): unknown {
  if (depth > 6) return null
  if (Array.isArray(value)) return value.map((v) => facetsSafe(v, depth + 1))
  const r = obj(value)
  if (!r) return value
  return Object.fromEntries(Object.entries(r).filter(([k]) => !/price/i.test(k)).map(([k, v]) => [k, facetsSafe(v, depth + 1)]))
}

export interface ProductSetsInput extends SetFilterInput {
  connectionId?: string | null
  view: typeof PRODUCT_SET_VIEWS[number]
  catalogId?: string | null
  productSetId?: string | null
  parentId?: string | null
  ancestorId?: string | null
  hasChildren?: boolean | null
  retailerId?: string | null
  errorType?: string | null
  errorPriority?: typeof SET_ERROR_PRIORITIES[number] | null
  facetFields?: string[] | null
  maxRows?: number
  /** The caller's field permissions (ToolContext.can): price conditions need revenue view (assertPriceFilterAllowed). */
  can?: FieldGate
}

/** Review A8 — every plain argument (and the price permission) checked before any call (database or Meta). */
function checkedSetArgs(input: ProductSetsInput): string[] {
  assertPriceFilterAllowed(input.conditions, input.can ?? (() => false))
  for (const [name, value] of [['parentId', input.parentId], ['ancestorId', input.ancestorId], ['productSetId', input.productSetId], ['catalogId', input.catalogId]] as const) {
    if (value && !metaObjectId(value)) throw new MetaLiveRefusal(`${name} is a Meta id (digits).`)
  }
  // Review A-F2 — step 12's list of Meta's item error types (the gateway allows only those): refused here, before any call.
  if (input.errorType && !META_ITEM_ERROR_TYPE_SET.has(input.errorType)) throw new MetaLiveRefusal('errorType is one of Meta\'s item error types (e.g. IMAGE_RESOLUTION_LOW; the list is in meta-catalog-items).')
  if (input.errorPriority && !(SET_ERROR_PRIORITIES as readonly string[]).includes(input.errorPriority)) throw new MetaLiveRefusal('errorPriority is HIGH, MEDIUM or LOW.')
  if (input.retailerId && (input.retailerId.length > 100 || /[\u0000-\u001f\u007f]/.test(input.retailerId))) throw new MetaLiveRefusal('retailerId is at most 100 characters of text.')
  const facetFields = [...new Set(input.facetFields?.length ? input.facetFields : ['brand', 'product_type', 'availability'])]
  const badFacet = facetFields.find((f) => !(SET_FACET_FIELDS as readonly string[]).includes(f))
  if (badFacet) throw new MetaLiveRefusal(`"${badFacet}" is not a field Nexus counts (${SET_FACET_FIELDS.join(', ')}).`)
  return facetFields
}

/** What an answer that used a filter says next to it (the rule as Nexus sent it; internal_label's open question). */
const narrowed = (rule: Row | null, priceCurrency: string | null) => (rule ? { narrowedBy: { ...setFilterOut(rule), priceCurrency }, ...(usesInternalLabel(rule) ? { internalLabelNote: INTERNAL_LABEL_NOTE } : {}) } : {})

export async function liveProductSets(input: ProductSetsInput) {
  const facetFields = checkedSetArgs(input)
  const account = await metaChosenAccount(input.connectionId)
  // The filter right after Nexus's own account row (a price condition's default currency is the ad account's), before any
  // Meta call.
  const { rule, priceCurrency } = input.view === 'items' || input.view === 'preview' || input.view === 'facets'
    ? productSetFilter(input, account.currency, { everyItem: true }) : { rule: null, priceCurrency: null }
  await catalogPortfolio(account)
  const { connectionId } = account
  const base = { view: input.view }
  const catalogOf = () => readableCatalog(account, need(input.catalogId, 'Name the catalog (catalogId, from meta-catalogs view list).'))
  const setOf = () => catalogChild(account, { kind: 'product_set', id: need(input.productSetId, 'Name the product set (productSetId, from view list).'), catalogId: input.catalogId })
  switch (input.view) {
    case 'list': {
      // CT-060 — the catalog's product sets (a level of the set tree: parentId 0 = top sets; ancestorId, hasChildren, retailerId).
      const catalog = await catalogOf()
      const query: Record<string, MetaQueryValue> = {
        fields: SET_LIST_FIELDS,
        ...(input.parentId ? { parent_id: input.parentId } : {}), ...(input.ancestorId ? { ancestor_id: input.ancestorId } : {}),
        ...(typeof input.hasChildren === 'boolean' ? { has_children: input.hasChildren } : {}), ...(input.retailerId ? { retailer_id: input.retailerId } : {}),
      }
      const read = await withNote(() => listPaged(connectionId, 'productSets.list', `${catalog.catalogId}/product_sets`, query, clampRows(input.maxRows, 100), true))
      return {
        ...base, catalogId: catalog.catalogId, total: read.totalCount, items: read.rows.map(setRow), more: read.more,
        note: 'A set\'s items are those its filter matches now (Meta re-applies it as items change). An empty set\'s ads do not deliver. The sets one item is in: meta-catalog-items view item-sets. Changing sets is a change tool (a later Nexus step).',
      }
    }
    case 'set': {
      // CT-061 — one set: filter, item count, metadata (live = what passed Meta's integrity review), ordering_info (SDK only).
      const { id, catalog } = await setOf()
      const read = await withNote(() => oneWithFallback(connectionId, 'productSets.one', id, SET_DETAIL_CORE, SET_DETAIL_MORE))
      const b = read.body
      return {
        ...base, catalogId: catalog.catalogId, relation: catalog.relation, ...setRow(b), autoCreationUrl: text(b.auto_creation_url),
        latestMetadata: tidy(b.latest_metadata ?? null), liveMetadata: tidy(b.live_metadata ?? null), orderingInfo: tidy(b.ordering_info ?? null),
        fieldsNote: read.note,
        notes: [
          'liveMetadata is what passed Meta\'s integrity review (what a shop collection shows); latestMetadata is the newest, maybe still in review.',
          'orderingInfo is in Meta\'s SDK only and Meta documents no meaning for it: shown as Meta answers it.',
        ],
      }
    }
    case 'items': {
      // CT-062 — the items in a set now, with prices (restricted), narrowed by conditions, an error type or priority.
      const { id, catalog } = await setOf()
      const read = await withNote(() => listPaged(connectionId, 'productSets.items', `${id}/products`, {
        fields: ITEM_LIST_FIELDS, ...(rule ? { filter: rule } : {}), ...(input.errorType ? { error_type: input.errorType } : {}),
        ...(input.errorPriority ? { error_priority: input.errorPriority } : {}),
      }, clampRows(input.maxRows, 100), true))
      return {
        ...base, catalogId: catalog.catalogId, productSetId: id, total: read.totalCount, ...narrowed(rule, priceCurrency),
        items: read.rows.map(itemRow), more: read.more, priceNote: PRICE_NOTE,
      }
    }
    case 'preview': {
      // CT-063 — THE preview of a set filter (Meta has no check on a set write): the count, a sample, and — for an existing
      // set — its count now, so a change shows items before → after (lane C4's set-meta-product-set reads this).
      const set = input.productSetId ? await setOf() : null
      const catalog: ReadableCatalog = set ? set.catalog : await catalogOf()
      const read = await withNote(() => listPaged(connectionId, 'productSets.preview', `${catalog.catalogId}/products`, { fields: ITEM_LIST_FIELDS, ...(rule ? { filter: rule } : {}) }, clampRows(input.maxRows, 10), true))
      const matching = read.totalCount ?? (read.more ? null : read.rows.length)
      let current: Row | null = null
      if (set) {
        const now = await withNote(() => metaReadOne({ connectionId }, { operation: 'productSets.previewCurrent', path: set.id, query: { fields: SET_LIST_FIELDS } }))
        const b = now.body as Row
        const itemsNow = num(b.product_count)
        current = { productSetId: set.id, name: text(b.name), itemsNow, itemsWithThisFilter: matching, change: itemsNow !== null && matching !== null ? matching - itemsNow : null, currentFilter: setFilterOut(b.filter) }
      }
      return {
        ...base, catalogId: catalog.catalogId, ...setFilterOut(rule ?? {}), priceCurrency, matchingItems: matching,
        willDeliver: matching === null ? null : matching > 0,
        ...(matching === 0 ? { warning: 'No item matches: a product set with this filter would be empty, and ads on it will not deliver (Meta).' } : {}),
        ...(usesInternalLabel(rule) ? { internalLabelNote: INTERNAL_LABEL_NOTE } : {}),
        current, sample: read.rows.map(itemRow), moreItems: read.more, priceNote: PRICE_NOTE, note: PREVIEW_NOTE,
      }
    }
    case 'facets': {
      // CT-903 — distinct values and counts of some fields (brands, types…), optionally under a filter: helps build a set.
      const catalog = await catalogOf()
      const read = await withNote(() => listWithFallback(connectionId, 'productSets.facets', `${catalog.catalogId}/facets`, 'facets', 'item_count', { facets: facetFields, ...(rule ? { filter: rule } : {}) }, 50))
      return {
        ...base, catalogId: catalog.catalogId, facetFields, ...narrowed(rule, priceCurrency),
        items: read.rows.map((r) => ({ itemCount: num(r.item_count), facets: tidy(facetsSafe(r.facets ?? null)) })), fieldsNote: read.note,
        note: 'Meta documents this read but not the shape of its facet request: Nexus sends the field names as a list. When Meta refuses, its words say why. Prices are never counted here.',
      }
    }
  }
}

// ── commerce accounts and shops (only the chosen Page's and the chosen portfolio's) ──────────────────────────────────

export const COMMERCE_VIEWS = ['accounts', 'account', 'shops', 'shop', 'setup-status', 'checkout-countries'] as const
export const COMMERCE_PORTFOLIO_SHARED = 'This Meta business portfolio is shared with another business in Nexus, so its commerce accounts are not read here (Nexus cannot tell whose shop is whose); the chosen Facebook Page\'s are.'
const COMMERCE_NO_PORTFOLIO = 'The chosen ad account names no business portfolio, so only the chosen Facebook Page\'s commerce accounts are read.'
const COMMERCE_NOTHING = 'No Facebook Page is chosen for this business and its business portfolio cannot be read here, so no commerce account is read. A person chooses the Page in Settings › Channels › Meta.'
export const COMMERCE_NOT_OWN = 'That commerce account is not the chosen Facebook Page\'s nor the business portfolio\'s, so it is not read.'
const COMMERCE_OF_ANOTHER_BUSINESS = 'That commerce account is the shop of a Facebook Page another business in Nexus uses, so it is not read here.'
export const COMMERCE_UNVERIFIED = 'Meta did not name that commerce account\'s Facebook Page, so Nexus cannot check that it is not another business\'s shop; it is not read (only its id is shown).'
const CMS_LIST_CORE = 'id,display_name,merchant_status'
// Review B3 / round 3 — shop.md documents only fb_sales_channel and ig_sales_channel (with status and fb_page / ig_user, but
// no sub-field selection: its sample answers fb_page{name}, ig_user{username}, no id; SDK api_specs Shop.json: Object).
// Nexus asks the channels with the Page's / Instagram account's id first (SHOP_CORE_EXPANDED, to check whose they are) and,
// when Meta refuses a field there, the plain documented channels (SHOP_CORE_PLAIN: a Page or account without an id is not
// shown). shop_status, commerce_merchant_settings and workspace (SDK shop.py only) are dropped and named when refused.
const SHOP_CORE_EXPANDED = 'id,fb_sales_channel{status,fb_page{id,name}},ig_sales_channel{status,ig_user{id,username}}'
const SHOP_CORE_PLAIN = 'id,fb_sales_channel,ig_sales_channel'
const SHOP_MORE = 'shop_status,commerce_merchant_settings,workspace'
export const SHOP_CHANNELS_PLAIN = 'Meta refused the Page and Instagram account details inside the sales channels, so they are read as Meta documents them: a Page or account Meta names without an id is not shown (Nexus cannot check whose it is).'

/** A shop read with the expanded channels, else (a field Meta refuses there) the plain documented ones. */
async function shopRead<T>(read: (core: string) => Promise<T>): Promise<{ value: T; channelsNote: string | null }> {
  try {
    return { value: await read(SHOP_CORE_EXPANDED), channelsNote: null }
  } catch (err) {
    if (!fieldRefused(err)) throw err
    return { value: await read(SHOP_CORE_PLAIN), channelsNote: `${SHOP_CHANNELS_PLAIN} (Meta: ${err.failure.sentence})` }
  }
}
const SETUP_CORE = 'shop_setup,payment_setup,review_status'
const SETUP_MORE = 'deals_setup,marketplace_approval_status,marketplace_approval_status_details'
const STATUS_WORDS: Readonly<Record<string, string>> = { ENABLED: 'on', EXTERNALLY_DISABLED: 'switched off from outside Meta (e.g. by the shop platform)', DISABLED: 'off', STAGING: 'being set up (not public)' }

const COMMERCE_PERMISSION_NOTE = 'If Meta\'s words name a permission: the system user needs the Facebook Page and the shop\'s catalog assigned in Meta Business settings and the token catalog_management (Meta: shops need catalog management); a read that needs the Page\'s own token comes with a later Nexus step.'

/** A read Meta may refuse for a permission: Meta's words and what a person can do about it. */
async function withPermissionNote<T>(note: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && err.failure.permissionDenied) throw new MetaLiveRefusal(`${err.message} ${note}`)
    throw err
  }
}
const withCommerceNote = <T>(work: () => Promise<T>) => withPermissionNote(COMMERCE_PERMISSION_NOTE, work)

/**
 * unverified (review A3): a portfolio account whose Page Meta did not name (merchant_page missing or refused) — Nexus cannot
 * check it is not another business's shop, so it fails CLOSED: its id only, never read.
 */
interface CommerceRow { commerceAccountId: string; on: 'page' | 'portfolio'; row: Row; takenByAnotherBusiness: boolean; unverified: boolean }

/** The chosen Page's and the (unshared) portfolio's commerce accounts; each list may fail alone (its words kept). */
async function commerceLists(account: MetaChosenAccount, maxRows: number) {
  const { connectionId } = account
  const page = account.pageId
    ? await part(() => withCommerceNote(() => listPaged(connectionId, 'commerce.pageAccounts', `${account.pageId}/commerce_merchant_settings`, { fields: CMS_LIST_CORE }, maxRows)))
    : null
  let portfolio: { rows: Row[]; notRead: string | null } | null = null
  let portfolioNote: string | null = null
  if (!account.businessId) portfolioNote = COMMERCE_NO_PORTFOLIO
  else if (await portfolioTaken(account.businessId)) portfolioNote = COMMERCE_PORTFOLIO_SHARED
  else {
    const read = await part(() => withCommerceNote(() => listWithFallback(connectionId, 'commerce.portfolioAccounts', `${account.businessId}/commerce_merchant_settings`, CMS_LIST_CORE, 'merchant_page{id}', {}, maxRows)))
    portfolio = { rows: read.value?.rows ?? [], notRead: read.notRead }
  }
  if (!page && !portfolio) throw new MetaLiveRefusal(portfolioNote === COMMERCE_PORTFOLIO_SHARED ? `${COMMERCE_PORTFOLIO_SHARED} No Facebook Page is chosen, so nothing is read.` : COMMERCE_NOTHING)
  // Round 3 — ids exact or not at all: an account whose id is not exact is left out; a Page id that is not exact = unverified.
  const uncounted: IdCount = { notExact: 0 }
  const pageIds = await takenIds('PAGE', (portfolio?.rows ?? []).map((r) => exactId(obj(r.merchant_page)?.id, uncounted)).filter((id): id is string => !!id && id !== account.pageId))
  const rows: CommerceRow[] = []
  for (const r of page?.value?.rows ?? []) {
    const id = exactId(r.id, uncounted)
    if (id) rows.push({ commerceAccountId: id, on: 'page', row: r, takenByAnotherBusiness: false, unverified: false })
  }
  for (const r of portfolio?.rows ?? []) {
    const id = exactId(r.id, uncounted)
    if (!id || rows.some((x) => x.commerceAccountId === id)) continue
    const merchantPage = exactId(obj(r.merchant_page)?.id, uncounted)
    rows.push({ commerceAccountId: id, on: 'portfolio', row: r, takenByAnotherBusiness: !!merchantPage && pageIds.has(merchantPage), unverified: !merchantPage })
  }
  return { rows, pageNotRead: page?.notRead ?? null, portfolioNotRead: portfolio?.notRead ?? null, portfolioNote }
}

/** A caller's commerce-account id (or the only one) — read only when it is the chosen Page's or the unshared portfolio's. */
async function ownCommerceAccount(account: MetaChosenAccount, wanted: string | null | undefined): Promise<{ commerceAccountId: string; on: 'page' | 'portfolio' }> {
  const id = wanted ? metaObjectId(wanted) : null
  if (wanted && !id) throw new MetaLiveRefusal(`"${wanted}" is not a Meta commerce account id (digits).`)
  const lists = await commerceLists(account, 100)
  const unread = [lists.pageNotRead, lists.portfolioNotRead].filter(Boolean).join(' ')
  const own = lists.rows.filter((r) => !r.takenByAnotherBusiness && !r.unverified)
  if (id) {
    if (lists.rows.some((r) => r.commerceAccountId === id && r.takenByAnotherBusiness)) throw new MetaLiveRefusal(COMMERCE_OF_ANOTHER_BUSINESS)
    if (lists.rows.some((r) => r.commerceAccountId === id && r.unverified)) throw new MetaLiveRefusal(COMMERCE_UNVERIFIED)
    const hit = own.find((r) => r.commerceAccountId === id)
    if (!hit) throw new MetaLiveRefusal(`${COMMERCE_NOT_OWN}${unread ? ` (Meta did not answer one of the lists: ${unread})` : ''}`)
    return { commerceAccountId: hit.commerceAccountId, on: hit.on }
  }
  if (own.length === 1) return { commerceAccountId: own[0].commerceAccountId, on: own[0].on }
  if (own.length === 0) throw new MetaLiveRefusal(`No commerce account (shop) is found for the chosen Facebook Page or the business portfolio.${unread ? ` Meta did not answer: ${unread}` : ''}`)
  throw new MetaLiveRefusal('There are several commerce accounts: name one (commerceAccountId, from view accounts).')
}

/** Ids at any depth (objects with an `id`), for the PAGE / INSTAGRAM taken checks. */
function idsIn(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 8) return out
  if (Array.isArray(value)) for (const v of value) idsIn(v, out, depth + 1)
  const r = obj(value)
  if (r) {
    // Round 3 — exact or not at all (maskAssets counts the inexact ones).
    const id = exactId(r.id, { notExact: 0 })
    if (id) out.add(id)
    for (const v of Object.values(r)) idsIn(v, out, depth + 1)
  }
  return out
}

/** Keys kept from an object of no documented shape: its id, states and kinds, on/off flags, counts, country codes. */
const KNOWN_KEY = /^(id|status|state|type|enabled|count|country|countries|country_code|is_[a-z0-9_]+|[a-z0-9_]+_(status|state|type|enabled|count))$/
/** A name, kept only next to the chosen Page's or Instagram account's own id. */
const NAME_KEY = /^(name|username|display_name)$/
/** Review A-F4 — a key that looks like a field name; a data-shaped key (a Page name, a URL) is left out with its value. */
const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/
const NAMES_HIDDEN = 'A name is shown only for the chosen Facebook Page or Instagram account; any other Page or account is its id only (one another business in Nexus uses: its id and the flag). Meta\'s channel, workspace, per-country set-up and approval objects have no documented shape (Meta\'s SDK only), so Nexus keeps from them only ids, states, kinds, on/off flags, counts and country codes; Commerce Manager shows the rest.'

/**
 * Review A6 — an SDK-only object of unknown shape (a commerce account's channels, a shop's workspace), by ALLOW-list:
 * only KNOWN_KEY leaves (and the lists / objects that hold them, under SAFE_KEY keys, never empty) are kept; a name (NAME_KEY) only next to the chosen
 * Page's or Instagram account's own id; every Page, Instagram account or portfolio another Nexus business uses is its id
 * and the flag only. Anything else — a link, a URL, a text, an id under another key, a name next to an id Nexus could not
 * check or on an object with no id — is left out.
 */
async function maskAssets(value: unknown, account: MetaChosenAccount, count: IdCount): Promise<unknown> {
  const ids = [...idsIn(value)]
  const taken = new Set([...(await takenIds('PAGE', ids)), ...(await takenIds('INSTAGRAM', ids)), ...(await takenIds('PORTFOLIO', ids))])
  const ours = new Set([account.pageId, account.instagramId].filter((id): id is string => !!id))
  /** An empty object or list says nothing (and under a key Nexus does not know, its key alone could be data). */
  const empty = (x: unknown) => (Array.isArray(x) ? x.length === 0 : !!obj(x) && Object.keys(x as Row).length === 0)
  /** known: the key this value sits under is one Nexus keeps (a plain value is kept only then). */
  const walk = (v: unknown, depth: number, known: boolean): unknown => {
    if (depth > 8) return undefined
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, known)).filter((x) => x !== undefined && (known || !empty(x)))
    const r = obj(v)
    if (!r) return known ? v : undefined
    // Round 3 — an id kept only exactly (a number too long to be exact is left out and counted).
    const id = exactId(r.id, count)
    if (id && taken.has(id)) return { id, takenByAnotherBusiness: true }
    const named = !!id && ours.has(id)
    const out: Row = {}
    for (const [k, x] of Object.entries(r)) {
      if (k === 'id') { if (id) out.id = id; continue }
      if (!SAFE_KEY.test(k)) continue
      const known = KNOWN_KEY.test(k) || (named && NAME_KEY.test(k))
      const kept = walk(x, depth + 1, known)
      if (kept === undefined) continue
      if (!known && empty(kept)) continue
      out[k] = kept
    }
    return out
  }
  return tidy(walk(value, 0, false) ?? null)
}

/** A shop's sales channel: its status in words and the Page or Instagram account (by id; another business's is the flag only). */
function channelOf(v: unknown, kind: 'page' | 'instagram', account: MetaChosenAccount, taken: Set<string>, count: IdCount) {
  const c = obj(v)
  if (!c) return null
  const status = text(c.status)
  const who = obj(kind === 'page' ? c.fb_page : c.ig_user)
  const id = exactId(who?.id, count)
  const chosen = kind === 'page' ? account.pageId : account.instagramId
  const asset = !who ? null
    : !id ? { id: null, note: who.id === undefined || who.id === null
      ? 'Meta named it without an id, so Nexus cannot check whose it is and does not show it.'
      : 'Meta sent its id in a form Nexus cannot read exactly, so Nexus cannot check whose it is and does not show it.' }
      : taken.has(id) ? { id, takenByAnotherBusiness: true }
        // Review A-F5 — a name only for the chosen Page / Instagram account (as NAMES_HIDDEN says); any other is its id only.
        : { id, ...(id === chosen ? { [kind === 'page' ? 'name' : 'username']: text(kind === 'page' ? who.name : who.username) } : {}), chosenHere: id === chosen, takenByAnotherBusiness: false }
  return { status, statusWords: status ? STATUS_WORDS[status] ?? null : null, [kind === 'page' ? 'page' : 'instagramAccount']: asset }
}

async function shopsOf(account: MetaChosenAccount, rows: Row[], count: IdCount) {
  const uncounted: IdCount = { notExact: 0 } // channelOf counts these
  const ids = rows.flatMap((r) => [exactId(obj(obj(r.fb_sales_channel)?.fb_page)?.id, uncounted), exactId(obj(obj(r.ig_sales_channel)?.ig_user)?.id, uncounted)]).filter((id): id is string => !!id)
  const taken = new Set([...(await takenIds('PAGE', ids)), ...(await takenIds('INSTAGRAM', ids))])
  return Promise.all(rows.map(async (r) => ({
    shopId: exactId(r.id, count), status: text(r.shop_status), facebook: channelOf(r.fb_sales_channel, 'page', account, taken, count), instagram: channelOf(r.ig_sales_channel, 'instagram', account, taken, count),
    commerceAccountId: exactId(obj(r.commerce_merchant_settings)?.id, count), workspace: r.workspace === undefined ? undefined : await maskAssets(r.workspace ?? null, account, count),
  })))
}

/**
 * Round 3 — a per-country set-up field: Meta's SDK (commercemerchantsettings.py) types checkout_config as a STRING. Text of
 * no documented shape is not shown, but it is never turned into null (that would read as "nothing set up"): it says so.
 * An object goes through maskAssets; true / false as they are.
 */
export const CONFIG_TEXT_NOT_SHOWN = 'Meta answered this set-up as text (its SDK types checkout_config as a string), which has no documented shape: the text is not shown here; Commerce Manager shows it.'
async function maskConfig(value: unknown, account: MetaChosenAccount, count: IdCount): Promise<unknown> {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() ? { textNotShown: true, note: CONFIG_TEXT_NOT_SHOWN } : null
  if (typeof value === 'boolean') return { value }
  return maskAssets(value ?? null, account, count)
}

/** Review A-F6 — the set-up status; its objects (SDK only, no documented shape) through maskAssets. */
async function setupOf(r: Row, account: MetaChosenAccount, count: IdCount) {
  return {
    shopSetup: text(r.shop_setup), paymentSetup: text(r.payment_setup), reviewStatus: await maskAssets(r.review_status ?? null, account, count), dealsSetup: text(r.deals_setup),
    marketplaceApprovalStatus: text(r.marketplace_approval_status), marketplaceApprovalDetails: await maskAssets(r.marketplace_approval_status_details ?? null, account, count),
  }
}

export interface CommerceInput { connectionId?: string | null; view: typeof COMMERCE_VIEWS[number]; commerceAccountId?: string | null; shopId?: string | null; country?: string | null; countries?: string[] | null; locale?: string | null; maxRows?: number }

export async function liveCommerce(input: CommerceInput) {
  // Every argument checked before any call (database or Meta).
  const country = input.country ? input.country.trim().toUpperCase() : null
  if (country && !/^[A-Z]{2}$/.test(country)) throw new MetaLiveRefusal(`"${input.country}" is not a country code (two letters, e.g. IT).`)
  // Review B4 — Meta's guide: the locale "follows BCP 47 format", so en_US is sent as en-US.
  const locale = input.locale ? input.locale.trim().replace('_', '-') : null
  if (locale && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) throw new MetaLiveRefusal(`"${input.locale}" is not a language code (BCP 47, e.g. it, en-US).`)
  const countries = [...new Set((input.countries ?? (country ? [country] : [])).map((c) => String(c).trim().toUpperCase()))]
  const badCountry = countries.find((c) => !/^[A-Z]{2}$/.test(c))
  if (badCountry) throw new MetaLiveRefusal(`"${badCountry}" is not a country code (two letters, e.g. IT).`)
  if (countries.length > 5) throw new MetaLiveRefusal('At most 5 countries in one read.')
  for (const [name, value] of [['commerceAccountId', input.commerceAccountId], ['shopId', input.shopId]] as const) {
    if (value && !metaObjectId(value)) throw new MetaLiveRefusal(`${name} is a Meta id (digits).`)
  }
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const base = { view: input.view }
  switch (input.view) {
    case 'accounts': {
      // CT-140 — the chosen Page's and the business portfolio's commerce accounts (a shop on Facebook / Instagram).
      const lists = await commerceLists(account, clampRows(input.maxRows, 25))
      return {
        ...base, pageId: account.pageId, portfolioId: account.businessId,
        items: lists.rows.map((r) => r.takenByAnotherBusiness
          ? { commerceAccountId: r.commerceAccountId, takenByAnotherBusiness: true }
          : r.unverified ? { commerceAccountId: r.commerceAccountId, unverified: true, why: COMMERCE_UNVERIFIED }
          : { commerceAccountId: r.commerceAccountId, name: text(r.row.display_name), status: text(r.row.merchant_status), statusWords: STATUS_WORDS[text(r.row.merchant_status) ?? ''] ?? null, foundOn: r.on === 'page' ? 'the chosen Facebook Page' : 'the business portfolio', takenByAnotherBusiness: false }),
        pageNotRead: lists.pageNotRead, portfolioNotRead: lists.portfolioNotRead, portfolioNote: lists.portfolioNote,
        note: 'A commerce account is what Meta calls a shop\'s "commerce merchant settings" (made by Commerce Manager or a shop platform such as Shopify). Its catalogs: meta-catalogs view shop-catalogs.',
      }
    }
    case 'account': {
      // CT-141 (and CT-147's field) — the account's settings; checkout, call to action and shop ads set-up per country, the
      // privacy policy per language; SDK-only fields each dropped and named when Meta refuses them.
      const own = await ownCommerceAccount(account, input.commerceAccountId)
      const id = own.commerceAccountId
      const groups: FieldGroup[] = [
        { name: 'core', fields: 'id,display_name,merchant_status,contact_email,terms' },
        { name: 'offsite checkout countries', fields: 'offsite_iab_checkout_enabled_countries' },
        { name: 'Page', fields: 'merchant_page{id,name}' },
        { name: 'channels', fields: 'facebook_channel,instagram_channel' },
        { name: 'payment provider', fields: 'payment_provider' },
      ]
      const read = await withCommerceNote(() => readGroups(connectionId, 'commerce.account', id, groups))
      const b = read.body
      // Review A3 — the Page check straight after the read, before anything else is read or returned.
      const page = obj(b.merchant_page)
      const pageId = exactId(page?.id, { notExact: 0 })
      // Round 3 — a Page Meta names with an id Nexus cannot read exactly cannot be checked: fail closed.
      if (page && page.id !== undefined && page.id !== null && !pageId) throw new MetaLiveRefusal(COMMERCE_UNVERIFIED)
      if (pageId && pageId !== account.pageId && (await takenIds('PAGE', [pageId])).has(pageId)) throw new MetaLiveRefusal(COMMERCE_OF_ANOTHER_BUSINESS)
      const count: IdCount = { notExact: 0 }
      const perCountry = country ? await Promise.all([['checkoutConfig', 'checkout_config'], ['callToAction', 'cta'], ['shopsAdsSetup', 'shops_ads_setup']].map(async ([key, field]) => {
        const got = await part(() => metaReadOne({ connectionId }, { operation: `commerce.account.${field}`, path: id, query: { fields: `id,${field}.country_code(${country})` } }))
        // Review A-F6 / round 3 — no documented shape: through maskConfig (text not shown, objects masked).
        return [key, got.value ? await maskConfig((got.value.body as Row)[field] ?? null, account, count) : { notRead: got.notRead }] as const
      })) : null
      const policy = locale ? await part(() => metaReadOne({ connectionId }, { operation: 'commerce.account.policy', path: id, query: { fields: `id,privacy_policy_localized.locale(${locale})` } })) : null
      const status = text(b.merchant_status)
      return {
        ...base, commerceAccountId: id, foundOn: own.on === 'page' ? 'the chosen Facebook Page' : 'the business portfolio', name: text(b.display_name),
        status, statusWords: status ? STATUS_WORDS[status] ?? null : null, contactEmail: text(b.contact_email), terms: text(b.terms),
        page: page ? { pageId, ...(pageId === account.pageId ? { name: text(page.name) } : {}), chosenHere: pageId === account.pageId } : null,
        offsiteCheckoutCountries: Array.isArray(b.offsite_iab_checkout_enabled_countries) ? strings(b.offsite_iab_checkout_enabled_countries) : null,
        facebookChannel: b.facebook_channel === undefined ? null : await maskAssets(b.facebook_channel, account, count), instagramChannel: b.instagram_channel === undefined ? null : await maskAssets(b.instagram_channel, account, count),
        paymentProvider: text(b.payment_provider),
        ...(country ? { country, perCountry: Object.fromEntries(perCountry ?? []) } : {}),
        ...(locale ? { locale, privacyPolicy: policy?.value ? tidy((policy.value.body as Row).privacy_policy_localized ?? null) : { notRead: policy?.notRead ?? null } } : {}),
        missing: read.missing, ...idsNote(count),
        notes: [
          'Checkout, call to action and shop ads set-up are per country (country); the privacy policy per language (locale). Meta: checkout set-up needs a shop platform\'s (partner) integration.',
          'offsiteCheckoutCountries, the Page, channels and payment provider are in Meta\'s SDK only: missing names any Meta refused. Changing these is in Commerce Manager (Meta documents a status, policy and checkout change for shop platforms only).',
          NAMES_HIDDEN,
        ],
      }
    }
    case 'shops': {
      // CT-144 — the account's shops and each shop's Facebook and Instagram sales channel (only channels set up appear).
      const own = await ownCommerceAccount(account, input.commerceAccountId)
      const { value: read, channelsNote } = await withCommerceNote(() => shopRead((core) => listWithFallback(connectionId, 'commerce.shops', `${own.commerceAccountId}/shops`, core, SHOP_MORE, {}, clampRows(input.maxRows, 25))))
      const count: IdCount = { notExact: 0 }
      return {
        ...base, commerceAccountId: own.commerceAccountId, items: await shopsOf(account, read.rows, count), more: read.more, fieldsNote: read.note, channelsNote, ...idsNote(count),
        note: `A shop's id is what a product set needs to show as a shop collection (publish_to_shops, a change in a later Nexus step). Only sales channels set up appear (Meta). ${NAMES_HIDDEN}`,
      }
    }
    case 'shop': {
      // CT-144 — one shop (checked to be a shop of one of the business's commerce accounts first).
      const shopId = need(metaObjectId(input.shopId), 'Name the shop (shopId, from view shops).')
      const candidates = input.commerceAccountId
        ? [await ownCommerceAccount(account, input.commerceAccountId)]
        : (await commerceLists(account, 25)).rows.filter((r) => !r.takenByAnotherBusiness && !r.unverified).slice(0, 5)
      let owner: string | null = null
      for (const c of candidates) {
        const shops = await withCommerceNote(() => listPaged(connectionId, 'commerce.shopCheck', `${c.commerceAccountId}/shops`, { fields: 'id' }, 100))
        if (shops.rows.some((r) => exactId(r.id, { notExact: 0 }) === shopId)) { owner = c.commerceAccountId; break }
      }
      if (!owner) throw new MetaLiveRefusal('That shop is not one of the shops of the business\'s commerce accounts (the chosen Page\'s or the business portfolio\'s), so it is not read.')
      const { value: read, channelsNote } = await withCommerceNote(() => shopRead((core) => oneWithFallback(connectionId, 'commerce.shop', shopId, core, SHOP_MORE)))
      const count: IdCount = { notExact: 0 }
      const shop = (await shopsOf(account, [read.body], count))[0]
      return { ...base, commerceAccountId: owner, shop, fieldsNote: read.note, channelsNote, ...idsNote(count), note: NAMES_HIDDEN }
    }
    case 'setup-status': {
      // CT-143 — the shop set-up status: of a commerce account (commerceAccountId), else the chosen Page's shop.
      const own = input.commerceAccountId || !account.pageId ? await ownCommerceAccount(account, input.commerceAccountId) : null
      const path = own ? `${own.commerceAccountId}/setup_status` : `${account.pageId}/shop_setup_status`
      const read = await withCommerceNote(() => listWithFallback(connectionId, 'commerce.setupStatus', path, SETUP_CORE, SETUP_MORE, {}, 10))
      const count: IdCount = { notExact: 0 }
      const items = await Promise.all(read.rows.map((r) => setupOf(r, account, count)))
      return {
        ...base, ...(own ? { commerceAccountId: own.commerceAccountId } : { pageId: account.pageId }), items, fieldsNote: read.note, ...idsNote(count),
        note: `The Page's shop set-up status is a documented Page read; a commerce account's and the status fields are in Meta's SDK only (Meta's answer decides). Setting a shop up is in Commerce Manager. ${NAMES_HIDDEN}`,
      }
    }
    case 'checkout-countries': {
      // CT-147 — where Shop checkout sends buyers to the website (offsite_iab_checkout_enabled_countries, SDK only), and the
      // documented checkout set-up per country (checkout_config.country_code(XX)).
      const own = await ownCommerceAccount(account, input.commerceAccountId)
      const read = await withCommerceNote(() => oneWithFallback(connectionId, 'commerce.checkoutCountries', own.commerceAccountId, 'id,display_name', 'offsite_iab_checkout_enabled_countries'))
      const perCountry = []
      const count: IdCount = { notExact: 0 }
      for (const c of countries) {
        const got = await part(() => metaReadOne({ connectionId }, { operation: 'commerce.checkoutConfig', path: own.commerceAccountId, query: { fields: `id,checkout_config.country_code(${c})` } }))
        perCountry.push({ country: c, checkoutConfig: got.value ? await maskConfig((got.value.body as Row).checkout_config ?? null, account, count) : null, notRead: got.notRead })
      }
      const listed = read.body.offsite_iab_checkout_enabled_countries
      return {
        ...base, commerceAccountId: own.commerceAccountId, name: text(read.body.display_name),
        offsiteCheckoutCountries: Array.isArray(listed) ? strings(listed) : null, fieldsNote: read.note, perCountry, ...idsNote(count),
        note: `Offsite checkout countries are where a buyer goes from Shop checkout to the website. The list is a field of Meta's SDK only (fieldsNote says when Meta refuses it); checkout set-up per country is documented. Changing them is in Commerce Manager (no API). ${NAMES_HIDDEN}`,
      }
    }
  }
}

// ── meta-instagram-product-tags (only the chosen Instagram account and its own media) ────────────────────────────────

export const IG_TAG_VIEWS = ['eligibility', 'catalogs', 'search', 'tags', 'appeal'] as const
// Meta's product-tagging requirements per edge (each reference page, checked 2026-10-21), for a system-user token: its role on
// the Page always comes through Business Manager; no Page token is needed. available_catalogs, catalog_product_search and
// product_appeal: "one of ads_management, ads_read"; GET /{ig-media}/product_tags: ads_read AND ads_management (round 2 B2).
const IG_SHOP_BASE = 'If Meta\'s words name a permission: the system user must be an ADMIN of the business portfolio that owns the Instagram Shop, the Instagram account needs an approved Instagram Shop, and the token needs catalog_management, instagram_basic, instagram_shopping_tag_products'
export const IG_SHOP_NOTE = `${IG_SHOP_BASE} and ads_read or ads_management (Meta: one of them, as the system user's role on the Page comes through Business Manager). No Page token is needed.`
export const IG_TAG_READ_NOTE = `${IG_SHOP_BASE}, ads_read AND ads_management (Meta's tag read needs both when the role on the Page comes through Business Manager, as a system user's does). No Page token is needed.`
const TAG_CORE = 'product_id,merchant_id,name,price_string,image_url,review_status,is_checkout,stripped_price_string,x,y'
const TAG_MORE = 'stripped_sale_price_string,product_url'
const SEARCH_FIELDS = 'product_id,product_name,retailer_id,image_url,review_status,is_checkout_flow,merchant_id,product_variants'
// Review B1 — the appeal fields documented on Meta's page are the core; the rest (SDK only) are dropped and named if refused.
const APPEAL_CORE = 'product_id,review_status,eligible_for_appeal'
const APPEAL_MORE = 'product_appeal_status,rejection_reasons'
/** Review B3 — Meta's tag read (GET /{ig-media}/product_tags) does not cover these media types. */
const NO_TAG_READ: Readonly<Record<string, string>> = { STORY: 'Stories', REELS: 'Reels', IGTV: 'IGTV videos', LIVE: 'Live videos' }
const TAG_LIMITS = 'Meta: at most 20 tags on a photo or video feed post, 5 per carousel slide (20 per carousel), 30 on a Reel; Stories, IGTV, Live and mentions take no tags, and Meta\'s tag read does not cover Reels either (the Instagram app shows a Reel\'s tags); 25 tagged posts per 24 hours (a carousel counts as one); none for Creator accounts. Only products whose review status is approved show on a post.'

/** An Instagram shopping read Meta may refuse for a permission: said plainly, with that edge's own permissions. */
const withShopNote = <T>(work: () => Promise<T>, note: string = IG_SHOP_NOTE) => withPermissionNote(note, work)


/** The catalogs the chosen Instagram account may tag from, each checked against step 12's rule. */
async function taggingCatalogs(account: MetaChosenAccount, instagramId: string, count: IdCount) {
  const read = await withShopNote(() => listPaged(account.connectionId, 'igTags.catalogs', `${instagramId}/available_catalogs`, { fields: 'catalog_id,catalog_name,shop_name,product_count' }, 25))
  const items: Row[] = []
  for (const r of read.rows) {
    const catalogId = exactId(r.catalog_id, count)
    if (!catalogId) continue
    const check = await part(() => readableCatalog(account, catalogId))
    if (check.notRead === CATALOG_OF_ANOTHER_BUSINESS) items.push({ catalogId, takenByAnotherBusiness: true })
    // A client catalog Meta names no owner for (step 12): Nexus cannot tell whose it is, so its id only — never its name or
    // shop name (it may be another Nexus business's).
    else if (check.notRead === CATALOG_NO_OWNER) items.push({ catalogId, readable: false, ownerUnknown: true, why: CATALOG_NO_OWNER })
    else if (!check.value) items.push({ catalogId, readable: false, why: check.notRead })
    else items.push({ catalogId, name: text(r.catalog_name), shopName: text(r.shop_name), productCount: num(r.product_count), relation: check.value.relation, readable: true, takenByAnotherBusiness: false })
  }
  return items
}

function tagRow(r: Row, count: IdCount) {
  const review = text(r.review_status)
  return {
    productId: exactId(r.product_id, count), name: text(r.name), merchantId: exactId(r.merchant_id, count), reviewStatus: review, showsOnPost: review === 'approved',
    checkoutInInstagram: bool(r.is_checkout), imageUrl: text(r.image_url), productUrl: text(r.product_url), x: num(r.x), y: num(r.y),
    // Money (restricted keys): Meta's price strings, read in minor units only when they name an ISO currency.
    ...itemMoney({ price: r.price_string, sale_price: r.stripped_sale_price_string }), otherPriceShown: text(r.stripped_price_string),
  }
}

export interface InstagramTagsInput { connectionId?: string | null; view: typeof IG_TAG_VIEWS[number]; catalogId?: string | null; search?: string | null; mediaId?: string | null; slides?: boolean; itemId?: string | null; maxRows?: number }

export async function liveInstagramProductTags(input: InstagramTagsInput) {
  const account = await metaChosenAccount(input.connectionId)
  const instagramId = instagramOf(account)
  const { connectionId } = account
  const base = { view: input.view, instagramId }
  switch (input.view) {
    case 'eligibility': {
      // CT-152 — may this account tag products (an approved Instagram Shop)? shopping_review_status is SDK only.
      const read = await withShopNote(() => oneWithFallback(connectionId, 'igTags.eligibility', instagramId, 'id,username,shopping_product_tag_eligibility', 'shopping_review_status'))
      const eligible = bool(read.body.shopping_product_tag_eligibility)
      return {
        ...base, username: text(read.body.username), eligible, shoppingReviewStatus: text(read.body.shopping_review_status), fieldsNote: read.note,
        sentence: eligible === true ? 'This Instagram account may tag products (it is linked to an approved Instagram Shop).'
          : eligible === false ? 'This Instagram account may not tag products: Meta finds no approved Instagram Shop linked to it (Creator accounts cannot tag; since 2023-08-10 businesses without a checkout-enabled Shop may have lost tagging).'
            : 'Meta did not say whether this account may tag products.',
        limits: TAG_LIMITS,
      }
    }
    case 'catalogs': {
      // CT-150 — the catalogs it may tag from (Meta answers one; collaborative catalogs are not supported), each checked.
      await catalogPortfolio(account)
      const count: IdCount = { notExact: 0 }
      const items = await taggingCatalogs(account, instagramId, count)
      return { ...base, items, ...idsNote(count), note: 'Instagram Shops use one catalog. A catalog is shown only when Nexus may read it (the chosen ad account\'s business portfolio owns it, or it is a client catalog of it whose owner Meta names and no other business in Nexus uses).' }
    }
    case 'search': {
      // CT-151 — tag-eligible products of a readable catalog (by name or SKU), with their review status.
      await catalogPortfolio(account)
      let catalogId = input.catalogId ? need(metaObjectId(input.catalogId), `"${input.catalogId}" is not a Meta catalog id (digits).`) : null
      if (!catalogId) {
        const readable = (await taggingCatalogs(account, instagramId, { notExact: 0 })).filter((c) => c.readable === true)
        if (readable.length !== 1) throw new MetaLiveRefusal(readable.length ? 'This account may tag from several catalogs: name one (catalogId, from view catalogs).' : 'Nexus finds no catalog this Instagram account may tag from that the business may read (view catalogs says why).')
        catalogId = readable[0].catalogId as string
      }
      const catalog = await readableCatalog(account, catalogId)
      const read = await withShopNote(() => listPaged(connectionId, 'igTags.search', `${instagramId}/catalog_product_search`, { catalog_id: catalog.catalogId, ...(input.search ? { q: input.search } : {}), fields: SEARCH_FIELDS }, clampRows(input.maxRows, 50)))
      const count: IdCount = { notExact: 0 }
      const items = read.rows.map((r) => {
        const review = text(r.review_status)
        return {
          productId: exactId(r.product_id, count), name: text(r.product_name), sku: text(r.retailer_id), reviewStatus: review, taggable: review === 'approved',
          checkoutInInstagram: bool(r.is_checkout_flow), merchantId: exactId(r.merchant_id, count), imageUrl: text(r.image_url),
          variants: (Array.isArray(r.product_variants) ? r.product_variants : []).map((v) => ({ productId: exactId(obj(v)?.product_id, count), name: text(obj(v)?.variant_name) })),
        }
      })
      return {
        ...base, catalogId: catalog.catalogId, search: input.search ?? null, items, ...idsNote(count),
        more: read.more,
        note: 'search matches a product\'s name or SKU (Meta\'s Content ID); without it every tag-eligible product is listed. Meta takes a tag on a product not yet approved without an error, but the tag does not show until it is approved.',
      }
    }
    case 'tags': {
      // CT-153 — the product tags on one of the chosen account's own posts (and its carousel slides on request).
      const media = await ownMedia(account, need(input.mediaId, 'Name the Instagram post (mediaId, from meta-instagram-media view media).'))
      const unread = media.productType ? NO_TAG_READ[media.productType.toUpperCase()] : undefined
      if (unread) throw new MetaLiveRefusal(`Meta's product-tag read does not cover ${unread} (it reads tags on feed photos, videos and carousels only), so this post's tags are not read. The Instagram app shows them.`)
      const read = await withShopNote(() => listWithFallback(connectionId, 'igTags.tags', `${media.mediaId}/product_tags`, TAG_CORE, TAG_MORE, {}, 30), IG_TAG_READ_NOTE)
      const count: IdCount = { notExact: 0 }
      const items = read.rows.map((r) => tagRow(r, count))
      let slides: Row[] | null = null
      if (input.slides) {
        // Round 3 — each read its own words: the slides are an Instagram media read (step 10's words), each slide's tags the tag read.
        const children = await withPermissionNote(PAGE_TOKEN_NOTE, () => listPaged(connectionId, 'igTags.slides', `${media.mediaId}/children`, { fields: 'id,media_type' }, 10))
        slides = []
        for (const child of children.rows) {
          const slideId = exactId(child.id, count)
          if (!slideId) continue
          const tags = await part(() => withShopNote(() => listWithFallback(connectionId, 'igTags.slideTags', `${slideId}/product_tags`, TAG_CORE, TAG_MORE, {}, 5), IG_TAG_READ_NOTE))
          slides.push({ slideId, mediaType: text(child.media_type), items: tags.value ? tags.value.rows.map((r) => tagRow(r, count)) : null, notRead: tags.notRead })
        }
      }
      return {
        ...base, mediaId: media.mediaId, productType: media.productType, items, slides, fieldsNote: read.note, ...idsNote(count),
        priceNote: 'A tag\'s price is Meta\'s own text (priceShown; otherPriceShown is its short form, salePriceShown the sale price). priceCents is filled only when the text names an ISO currency (e.g. 49.90 EUR).',
        note: `x and y place a tag on the photo (0–1 from the top-left). ${TAG_LIMITS} Adding or moving tags is a change (a later Nexus step); Meta cannot remove a tag through its API (Instagram app only).`,
      }
    }
    case 'appeal': {
      // CT-157 — the appeal state of a product rejected for tagging (an item of a readable catalog, checked first).
      const { id, catalog } = await catalogChild(account, { kind: 'item', id: need(input.itemId, 'Name the product (itemId: Meta\'s product id, from view search or meta-catalog-items).'), catalogId: input.catalogId })
      const read = await withShopNote(() => listWithFallback(connectionId, 'igTags.appeal', `${instagramId}/product_appeal`, APPEAL_CORE, APPEAL_MORE, { product_id: id }, 5))
      const count: IdCount = { notExact: 0 }
      const items = read.rows.map((r) => ({ productId: exactId(r.product_id, count), reviewStatus: text(r.review_status), eligibleForAppeal: bool(r.eligible_for_appeal), appealStatus: text(r.product_appeal_status), rejectionReasons: strings(r.rejection_reasons) }))
      return {
        ...base, catalogId: catalog.catalogId, productId: id, items, ...idsNote(count),
        fieldsNote: read.note,
        note: 'Sending an appeal is a change (a later Nexus step); Meta answers it with success only, not the outcome — read this view again later.',
      }
    }
  }
}
