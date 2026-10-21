/**
 * Meta ads step 12 (2026-10-21) — the catalog reads, LIVE from Meta through the gateway (GET only): catalogs, their data
 * sources and who writes them (Owner decision D7), items, item groups, batch results, feeds and their uploads, and catalog
 * health. Nothing here stores anything; a caller never names a Graph field or path (fixed field lists per node type).
 *
 * WHICH catalogs a business may read and write, and WHO writes a catalog's items (D7): catalog-rule.ts (a leaf module,
 * fix A4) — readableCatalog (the read rule), catalogChild (every id below a catalog), catalogWriter (D7) and
 * writableCatalog (the write rule lane C4 uses; never the read rule). Import them from catalog-rule.ts; nothing is
 * re-exported here.
 *
 * Prices: an item's `price` / `sale_price` are read back as a string with the currency (the reference names the type
 * only; the exact format is a LIVE-PROBES row). Nexus answers them in minor units of the ITEM's currency
 * (priceCents, salePriceCents) next to Meta's own string (priceShown, salePriceShown) — all restricted fields of the tool.
 *
 * Checked 2026-10-21 (curl, ≥3 s apart; developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md
 * and developers.facebook.com/docs/marketing-api/reference/<node>/; Meta's Python Business SDK main,
 * facebook_business/adobjects/<node>.py):
 *   - product-catalog: fields id, business ("Business that owns a catalog"), da_display_settings, default_image_url,
 *     fallback_image_url, feed_count, is_catalog_segment, is_local_catalog, name, product_count, vertical; SDK only:
 *     store_catalog_settings, commerce_merchant_settings, catalog_store, user_access_expire_time, owner_business. Edges:
 *     agencies, assigned_users (business REQUIRED; tasks, permitted_tasks, summary total_count), catalog_segments
 *     (summary), check_batch_request_status (handle required, load_ids_of_invalid_requests default false: invalid ids
 *     empty unless true), collaborative_ads_share_settings, connected_businesses (role), data_sources
 *     (ingestion_source_type ALL | PRIMARY | SUPPLEMENTARY, default PRIMARY; node fields app_id, id,
 *     ingestion_source_type, name, upload_type: SDK productcatalogdatasource.py only), diagnostics (types, severities,
 *     affected_channels, affected_entities, affected_features), dpa_eligible_ad_accounts (limit, search),
 *     event_stats (breakdowns DEVICE_TYPE; ProductEventStat SDK fields), external_event_sources (summary total_count;
 *     id, name, source_type), product_feeds, product_groups (summary), product_sets_batch (handle), products
 *     (bulk_pagination, error_priority, error_type ≈176 values, filter = the product-set filter rule,
 *     return_only_approved_products: WhatsApp only), smart_pixel_settings (no params), bundle_folders (no params).
 *     smart_pixel_stats is in Meta's index but its page is "Page Not Found" (RECHECK SG-121): read, Meta's answer decides.
 *   - product-item (docs/marketing-api/reference/product-item): read params catalog_id, image_height, image_width,
 *     override_country, override_language (named only); fields incl. price, sale_price, currency (string), product_catalog,
 *     product_feed, review_status {pending, rejected, approved, outdated}, review_rejection_reasons,
 *     capability_to_review_status, errors (ProductItemError: title, description, error_type, error_priority),
 *     generated_background_images, video_fetch_status, videos; edge product_sets. SDK only: product_group, status,
 *     edges override_details (keys, type), channels_to_integrity_status, videos_metadata (RECHECK CT-023/024/026).
 *   - product-group/products ("Products for a given product group"); ProductGroup fields id, product_catalog, retailer_id,
 *     variants: SDK only (its node page is 404, RECHECK CT-051).
 *   - product-feed: fields id, country, created_time, default_currency, deletion_enabled ("once enabled cannot be
 *     disabled", facts F2), delimiter, encoding, file_name, ingestion_source_type {primary_feed, supplementary_feed},
 *     item_sub_type, latest_upload, migrated_from_feed_id, name, override_type, primary_feeds, product_count,
 *     quoted_fields_mode, schedule (full replace), update_schedule (upsert only); SDK only supplementary_feeds, feed_type,
 *     override_value, use_case. Edges products (as the catalog's), rules (attribute, rule_type, params), upload_schedules
 *     (no params), uploads (no params). No catalog field: a feed is found in its catalog's own list.
 *   - product-feed-upload: id, start_time, end_time, input_method {Manual Upload, Server Fetch, Google Sheets Fetch,
 *     Reupload Last File, User initiated server fetch}, filename, url, num_detected/persisted/invalid/deleted_items,
 *     error_count, warning_count, error_report; edge errors (error_priority: HIGH = fatal, MEDIUM or LOW = all warnings;
 *     summary total_count; a SAMPLE); upload error edge suggested_rules (ProductFeedRuleSuggestion: attribute, params,
 *     type); the errors' samples edge "can't" be read (RECHECK CT-086) — not asked.
 *   - ads-pixel/da_checks: checks (pixel_missing_param_in_events, pixel_decline), connection_method ALL | APP | BROWSER |
 *     SERVER (DACheck: key, title, description, result, user_message, action_uri).
 *   - business/owned_product_catalogs, client_product_catalogs (permitted_roles), collaborative_ads_collaboration_requests
 *     (request_role SENDER default | RECEIVER, status, since, until), collaborative_ads_suggested_partners (no params);
 *     cpas_business_setup_config, cpas_merchant_config: SDK only (RECHECK CT-133) — read, Meta's answer decides.
 *   - page: edges product_catalogs ("product catalogs owned by the Page", RECHECK CT-004) and commerce_merchant_settings
 *     (SDK page.py); the commerce account's product_catalogs (RECHECK CT-005).
 *   - Not read, with the reason in the tool: additional_reviews is a WRITE (an appeal; RECHECK CT-904); the
 *     `catalog:{id}:{base64url(sku)}` form is a preview token, not a read (RECHECK-C4 CT-049) — an item by SKU is the
 *     products filter `retailer_id`; Meta's product category list is a file on facebook.com, not a Graph read (CT-178).
 */
import { metaAdAccountId } from '../../cx/connectors/meta/discovery.js'
import { META_ITEM_OVERRIDE_FIELD } from '../../gateway/meta-calls.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { listPaged, listWithFallback, oneWithFallback, part } from './paging.js'
import { tidy } from './live-media.js'
import { currencyExponent } from './money.js'
import { takenIds } from './taken.js'
import {
  catalogChild, catalogPortfolio, catalogWriter, CATALOG_NO_OWNER, clientCatalogIds, DATA_SOURCE_MORE, hiddenNote, hostOf, nameOrHost, need, readableCatalog, type ReadableCatalog,
} from './catalog-rule.js'

type Row = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const list = (v: unknown): Row[] => {
  const rows = Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]) : []
  return rows.filter((r): r is Row => !!obj(r))
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter((s): s is string => !!s) : [])
const clampRows = (n: number | undefined, dflt = 100) => Math.min(500, Math.max(1, Math.trunc(n ?? dflt)))
/** Catalogs whose writer the list and event-source views read (each costs its own calls). */
const MAX_DEEP_CATALOGS = 10

// ── prices: minor units of the item's currency ────────────────────────────────────────────────────────────────────

/** An ISO currency code written in Meta's price string ("49.90 EUR"), when the item names none. */
function currencyInText(shown: unknown): string | null {
  const match = typeof shown === 'string' ? /\b([A-Z]{3})\b/.exec(shown) : null
  return match ? match[1] : null
}

/**
 * Meta's price string ("€49.90", "49,90 €", "49.90 EUR", "$1,234.56", "¥1,234") → minor units of `currency` (EUR 4990),
 * or null when it cannot be read for sure. The last separator is the decimal one unless the number reads as thousands
 * groups ("1,234", "12.345.678") in a currency without three decimals; when both '.' and ',' appear, the last one is the
 * decimal one. Rounded half up past the currency's decimals. No floating point.
 */
export function catalogPriceMinor(shown: unknown, currency: string | null): number | null {
  if (typeof shown !== 'string' || !currency) return null
  const match = /-?\d(?:[\d.,'\s  ]*\d)?/.exec(shown)
  if (!match) return null
  const negative = match[0].startsWith('-')
  const body = match[0].replace(/^-/, '').replace(/['\s  ]/g, '')
  const exp = currencyExponent(currency)
  const seps = [...body.matchAll(/[.,]/g)].map((m) => ({ at: m.index ?? 0, sign: m[0] }))
  let whole = body
  let fraction = ''
  if (seps.length) {
    const last = seps[seps.length - 1]
    const after = body.length - last.at - 1
    const mixed = new Set(seps.map((s) => s.sign)).size > 1
    // Thousands grouping only as "1,234" / "12.345.678": 1–3 digits (not a lone 0) first, then groups of exactly three.
    const groups = body.split(/[.,]/)
    const grouping = /^[1-9]\d{0,2}$/.test(groups[0]) && groups.slice(1).every((g) => g.length === 3)
    const decimal = mixed || !grouping || exp === 3
    if (decimal) {
      // Separators before the decimal one must group thousands properly ("1.234.567,89"), and never be the decimal sign.
      const intGroups = body.slice(0, last.at).split(/[.,]/)
      if (seps.slice(0, -1).some((s) => s.sign === last.sign)) return null
      if (intGroups.length > 1 && !(/^[1-9]\d{0,2}$/.test(intGroups[0]) && intGroups.slice(1).every((g) => g.length === 3))) return null
      whole = body.slice(0, last.at).replace(/[.,]/g, '')
      fraction = body.slice(last.at + 1)
    } else {
      whole = body.replace(/[.,]/g, '')
    }
  }
  if (!/^\d{1,15}$/.test(whole) || !/^\d*$/.test(fraction)) return null
  const kept = (fraction + '0'.repeat(exp)).slice(0, exp)
  let minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt(kept || '0')
  if (fraction.length > exp && Number(fraction[exp]) >= 5) minor += 1n
  const value = Number(negative ? -minor : minor)
  return Number.isSafeInteger(value) ? value : null
}

/** An item's money: minor units of its currency and Meta's own strings (all restricted fields of the tool). */
export function itemMoney(r: Row) {
  const currency = text(r.currency) ?? currencyInText(r.price) ?? currencyInText(r.sale_price)
  return {
    currency,
    priceCents: catalogPriceMinor(r.price, currency),
    priceShown: text(r.price),
    salePriceCents: catalogPriceMinor(r.sale_price, currency),
    salePriceShown: text(r.sale_price),
  }
}

/** Fix A6 — every key naming a price (price, sale_price, unit_price, live_special_price, …) except a date. */
const isMoneyKey = (key: string) => /price/i.test(key) && !/date/i.test(key)
/**
 * A part of Meta's answer that may carry an item's price (an override's values): every price key becomes priceShown /
 * salePriceShown, or goes under otherPriceShown by its own name (all restricted fields), as `{ key: 'price', value }`
 * pairs and as plain keys.
 */
export function moneySafe(value: unknown, depth = 0): unknown {
  if (depth > 8) return null
  if (Array.isArray(value)) return value.map((v) => moneySafe(v, depth + 1))
  const row = obj(value)
  if (!row) return value
  const out: Row = {}
  const put = (key: string, child: unknown) => {
    if (/^price$/i.test(key)) out.priceShown = child
    else if (/^sale_?price$/i.test(key)) out.salePriceShown = child
    else out.otherPriceShown = { ...(obj(out.otherPriceShown) ?? {}), [key]: child }
  }
  const pairKey = typeof row.key === 'string' ? row.key : null
  for (const [key, child] of Object.entries(row)) {
    if (pairKey && isMoneyKey(pairKey) && key === 'value') put(pairKey, child)
    else if (isMoneyKey(key)) put(key, child)
    else out[key] = moneySafe(child, depth + 1)
  }
  return out
}

// ── field lists (fixed per node type) ─────────────────────────────────────────────────────────────────────────────

export const CATALOG_LIST_FIELDS = 'id,name,business{id,name},vertical,product_count,feed_count,is_catalog_segment,is_local_catalog'
const CATALOG_DETAIL_CORE = `${CATALOG_LIST_FIELDS},da_display_settings,default_image_url,fallback_image_url`
const CATALOG_DETAIL_MORE = 'store_catalog_settings,commerce_merchant_settings{id,display_name},catalog_store,user_access_expire_time'
export const ITEM_LIST_FIELDS = 'id,retailer_id,retailer_product_group_id,name,brand,availability,condition,price,sale_price,currency,review_status,visibility,image_url,url,errors'
/** Health lists: no prices (the health tool holds no money). */
const ITEM_HEALTH_FIELDS = 'id,retailer_id,retailer_product_group_id,name,availability,review_status,review_rejection_reasons,errors'
// Rebase on step 14 (#708) — no `tags`: the gateway never asks a field named `tags` (FIELD_DENIED), because on posts and
// Instagram media it lists tagged people, and a numeric id does not tell the gateway which node it is. An item's tags are
// therefore not read here; a product set can still FILTER on them (step 13's set filter, not a field).
export const ITEM_DETAIL_CORE = [
  'id', 'retailer_id', META_ITEM_OVERRIDE_FIELD, 'parent_product_id', 'name', 'description', 'short_description', 'rich_text_description', 'brand',
  'category', 'fb_product_category', 'product_type', 'condition', 'availability', 'quantity_to_sell_on_facebook', 'price', 'sale_price',
  'sale_price_start_date', 'sale_price_end_date', 'currency', 'url', 'mobile_link', 'image_url', 'images', 'additional_image_urls', 'image_fetch_status',
  'videos', 'video_fetch_status', 'color', 'size', 'material', 'pattern', 'gender', 'age_group', 'gtin', 'manufacturer_part_number', 'origin_country',
  'importer_name', 'importer_address', 'manufacturer_info', 'product_disclosures', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3',
  'custom_label_4', 'custom_number_0', 'custom_number_1', 'custom_number_2', 'custom_number_3', 'custom_number_4', 'additional_variant_attributes',
  'shipping_weight_value', 'shipping_weight_unit', 'expiration_date', 'visibility', 'review_status', 'review_rejection_reasons',
  'capability_to_review_status', 'capabilities_disabled_by_user', 'errors', 'invalidation_errors', 'generated_background_images',
  'generated_background_images_ad_usage', 'commerce_insights', 'product_catalog{id}', 'product_feed{id,name}',
].join(',')
const ITEM_DETAIL_MORE = 'product_group{id},status'
const SCHEDULE_FIELDS = 'interval,interval_count,hour,minute,day_of_week,day_of_month,timezone,url'
const UPLOAD_FIELDS = 'id,start_time,end_time,input_method,filename,url,num_detected_items,num_persisted_items,num_invalid_items,num_deleted_items,error_count,warning_count'
const FEED_LIST_FIELDS = `id,name,file_name,country,default_currency,deletion_enabled,ingestion_source_type,override_type,product_count,created_time,schedule{${SCHEDULE_FIELDS}},update_schedule{${SCHEDULE_FIELDS}},latest_upload{${UPLOAD_FIELDS}}`
const FEED_DETAIL_CORE = `${FEED_LIST_FIELDS},delimiter,encoding,quoted_fields_mode,item_sub_type,migrated_from_feed_id,primary_feeds`
/** Fix B1 — feed_type, override_value and use_case are create parameters, not fields Meta reads back: not asked. */
const FEED_DETAIL_MORE = 'supplementary_feeds'
const DIAGNOSTIC_FIELDS = 'title,subtitle,type,severity,error_code,number_of_affected_items,number_of_affected_entities,affected_channels,affected_entity,affected_features,diagnostics'
const EVENT_STAT_FIELDS = 'date_start,date_stop,event,event_source,device_type,total_matched_content_ids,total_unmatched_content_ids,unique_matched_content_ids,unique_unmatched_content_ids,total_content_ids_matched_other_catalogs,unique_content_ids_matched_other_catalogs'
const EVENT_SOURCE_FIELDS = 'id,name,source_type'

// ── shared rows ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A feed's fetch address as its host only: a feed or upload address may hold a key or a password. */
function scheduleOf(v: unknown) {
  // Fix B4 — Meta's reference does not say which time zone a schedule without one uses: null, not a guess.
  const s = obj(v)
  if (!s) return null
  return {
    interval: text(s.interval), intervalCount: num(s.interval_count), hour: num(s.hour), minute: num(s.minute), dayOfWeek: text(s.day_of_week),
    dayOfMonth: num(s.day_of_month), timeZone: text(s.timezone), fetchHost: hostOf(s.url),
  }
}

/**
 * Fix B5 (round 3) — an upload's error report (ProductFeedUploadErrorReport: file_handle, report_status; Meta's SDK). A
 * handle that is an address is its host only: a key may sit in its path, not only in a query.
 */
function errorReportOf(v: unknown) {
  const r = obj(v)
  if (!r) return null
  return { status: text(r.report_status), file: nameOrHost(r.file_handle), ...hiddenNote('fileHidden', r.file_handle) }
}

function uploadOf(v: unknown) {
  const u = obj(v)
  if (!u) return null
  const deleted = num(u.num_deleted_items)
  return {
    uploadId: idText(u.id), startTime: text(u.start_time), endTime: text(u.end_time), inputMethod: text(u.input_method), fileName: nameOrHost(u.filename), ...hiddenNote('fileNameHidden', u.filename), fetchHost: hostOf(u.url),
    itemsDetected: num(u.num_detected_items), itemsSaved: num(u.num_persisted_items), itemsInvalid: num(u.num_invalid_items), itemsDeleted: deleted,
    errors: num(u.error_count), warnings: num(u.warning_count),
    ...(deleted && deleted > 0 ? { note: 'Items were deleted: a full upload removes items missing from the file.' } : {}),
  }
}

function feedOf(r: Row) {
  const supplementary = /supplementary/i.test(String(r.ingestion_source_type ?? ''))
  const overrideType = text(r.override_type)
  return {
    feedId: idText(r.id), name: nameOrHost(r.name), ...hiddenNote('nameHidden', r.name), fileName: nameOrHost(r.file_name), ...hiddenNote('fileNameHidden', r.file_name), country: text(r.country), defaultCurrency: text(r.default_currency),
    kind: supplementary ? 'supplementary (changes fields of the primary feed\'s items only)' : 'primary (adds and removes items)',
    overrideType, deletionEnabled: bool(r.deletion_enabled), productCount: num(r.product_count), createdTime: text(r.created_time),
    schedule: scheduleOf(r.schedule), updateSchedule: scheduleOf(r.update_schedule), latestUpload: uploadOf(r.latest_upload),
    notes: [
      ...(r.deletion_enabled === true ? ['deletion_enabled is on: a full upload deletes items missing from the file, and Meta never lets it be turned off again.'] : []),
      ...(overrideType && /country/i.test(overrideType) ? ['A country feed: it carries price, sale price, availability, link and status per country.'] : []),
      ...(overrideType && /language/i.test(overrideType) ? ['A language feed: it carries the items\' text per language.'] : []),
    ],
  }
}

const errorsOf = (v: unknown) => list(v).map((e) => ({ title: text(e.title), description: text(e.description), errorType: text(e.error_type), priority: text(e.error_priority) }))

export function itemRow(r: Row) {
  return {
    itemId: idText(r.id), sku: text(r.retailer_id), groupSku: text(r.retailer_product_group_id), name: text(r.name), brand: text(r.brand),
    availability: text(r.availability), condition: text(r.condition), ...itemMoney(r), reviewStatus: text(r.review_status), visibility: text(r.visibility),
    imageUrl: text(r.image_url), url: text(r.url), errors: errorsOf(r.errors),
  }
}

function healthItemRow(r: Row) {
  return {
    itemId: idText(r.id), sku: text(r.retailer_id), groupSku: text(r.retailer_product_group_id), name: text(r.name), availability: text(r.availability),
    reviewStatus: text(r.review_status), rejectionReasons: strings(r.review_rejection_reasons), errors: errorsOf(r.errors),
  }
}

/** Business portfolios (partners, owners): another Nexus business's is its id and the flag only. */
async function maskPortfolios(rows: Row[]) {
  const taken = await takenIds('PORTFOLIO', rows.map((r) => idText(r.id)).filter((id): id is string => !!id))
  return rows.map((r) => {
    const id = idText(r.id)
    return id && taken.has(id) ? { businessId: id, takenByAnotherBusiness: true } : { businessId: id, name: text(r.name), takenByAnotherBusiness: false }
  })
}

/** A catalog row of a list: readable (owned by the portfolio, or a client catalog of it), else what may be said of it. */
function catalogRow(r: Row, portfolioId: string, clients: Set<string>, takenOwners: Set<string>) {
  const id = idText(r.id)
  const owner = obj(r.business)
  const ownerId = idText(owner?.id)
  if (id && ownerId && takenOwners.has(ownerId)) return { catalogId: id, takenByAnotherBusiness: true }
  const relation = ownerId && ownerId === portfolioId ? 'owned' : id && clients.has(id) ? 'client' : null
  if (!relation) return { catalogId: id, readable: false, why: 'Not owned by the chosen ad account\'s business portfolio, nor a client catalog of it.' }
  // Fix A1 — a client catalog whose owner Meta does not name: its id only, never read.
  if (relation === 'client' && !ownerId) return { catalogId: id, readable: false, why: CATALOG_NO_OWNER }
  return {
    catalogId: id, name: text(r.name), relation, ...(relation === 'client' ? { ownerBusiness: { businessId: ownerId, name: text(owner?.name) }, permittedRoles: strings(r.permitted_roles) } : {}),
    vertical: text(r.vertical), productCount: num(r.product_count), feedCount: num(r.feed_count), isSegment: bool(r.is_catalog_segment), isLocal: bool(r.is_local_catalog),
    readable: true, takenByAnotherBusiness: false,
    ...(r.is_catalog_segment === true ? { segmentNote: 'A catalog segment (a part of a parent catalog): catalog ads must be built from it as a segment.' } : {}),
  }
}

/** Rows of a catalog list (a Page's, a shop's) checked against the portfolio; the client list is read only when needed. */
async function checkedCatalogRows(account: MetaChosenAccount, portfolioId: string, rows: Row[]) {
  const owners = rows.map((r) => idText(obj(r.business)?.id)).filter((id): id is string => !!id && id !== portfolioId)
  const clients = owners.length ? await clientCatalogIds(account, portfolioId) : new Set<string>()
  const takenOwners = await takenIds('PORTFOLIO', owners)
  return rows.map((r) => catalogRow(r, portfolioId, clients, takenOwners))
}

/** The readable catalogs of the portfolio (owned + client), for views across catalogs. */
async function portfolioCatalogs(account: MetaChosenAccount, portfolioId: string, maxRows: number) {
  const owned = await listPaged(account.connectionId, 'catalogs.owned', `${portfolioId}/owned_product_catalogs`, { fields: CATALOG_LIST_FIELDS }, maxRows, true)
  const client = await listPaged(account.connectionId, 'catalogs.client', `${portfolioId}/client_product_catalogs`, { fields: `${CATALOG_LIST_FIELDS},permitted_roles` }, maxRows, true)
  const clients = new Set(client.rows.map((r) => idText(r.id)).filter((id): id is string => !!id))
  const takenOwners = await takenIds('PORTFOLIO', client.rows.map((r) => idText(obj(r.business)?.id)).filter((id): id is string => !!id && id !== portfolioId))
  // A row of the owned list is the portfolio's own even when Meta leaves its business out.
  const ownedRows = owned.rows.map((r) => (idText(obj(r.business)?.id) ? r : { ...r, business: { id: portfolioId } }))
  const rows = [...ownedRows, ...client.rows.filter((r) => !owned.rows.some((o) => idText(o.id) === idText(r.id)))]
  return {
    rows: rows.map((r) => catalogRow(r, portfolioId, clients, takenOwners)),
    owned: owned.totalCount, client: client.totalCount, more: owned.more || client.more,
  }
}

/** A ReadableCatalog for a list row already checked (no second owner read). */
function readableOfRow(row: ReturnType<typeof catalogRow>, portfolioId: string): ReadableCatalog | null {
  const r = row as Row
  if (r.readable !== true || typeof r.catalogId !== 'string') return null
  return {
    catalogId: r.catalogId, portfolioId, relation: r.relation as 'owned' | 'client', ownerBusinessId: r.relation === 'owned' ? portfolioId : (obj(r.ownerBusiness)?.businessId as string | null) ?? null,
    name: (r.name as string | null) ?? null, vertical: (r.vertical as string | null) ?? null, productCount: (r.productCount as number | null) ?? null, isSegment: (r.isSegment as boolean | null) ?? null,
  }
}

const NO_PAGE = 'No Facebook Page is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'
const PERMISSION_NOTE = 'If Meta\'s words name a permission: the system user needs the catalog assigned in Meta Business settings (Catalogs) and the token catalog_management.'

/** A read that may need a permission the system user lacks: said plainly. */
export async function withNote<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && err.failure.permissionDenied) throw new MetaLiveRefusal(`${err.message} ${PERMISSION_NOTE}`)
    throw err
  }
}

// ── meta-catalogs ─────────────────────────────────────────────────────────────────────────────────────────────────

export const CATALOG_VIEWS = ['list', 'catalog', 'writer', 'data-sources', 'segments', 'event-sources', 'people', 'partners', 'collaborative', 'bundle-folders', 'smart-pixel', 'page-catalogs', 'shop-catalogs', 'categories'] as const
export const DATA_SOURCE_TYPES = ['ALL', 'PRIMARY', 'SUPPLEMENTARY'] as const
export const CATEGORY_LIST_NOTE = 'Meta\'s product category list (for fb_product_category) is a file on facebook.com (https://www.facebook.com/products/categories/en_US.txt, other languages in Meta\'s Help Center), not a Graph API read, and Nexus reads Meta only through the Graph API, so it is not read here. Google\'s product taxonomy ids (google_product_category) are accepted too. The categories a catalog\'s own products fall into: meta-ad-details view catalog-categories (of the catalog an ad set promotes).'

export interface CatalogsInput { connectionId?: string | null; view: typeof CATALOG_VIEWS[number]; catalogId?: string | null; sourceType?: typeof DATA_SOURCE_TYPES[number] | null; maxRows?: number }

export async function liveCatalogs(input: CatalogsInput) {
  const account = await metaChosenAccount(input.connectionId)
  if (input.view === 'categories') return { view: input.view, note: CATEGORY_LIST_NOTE }
  const portfolioId = await catalogPortfolio(account)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 100)
  const base = { view: input.view, portfolioId }
  const one = async () => readableCatalog(account, need(input.catalogId ?? null, 'Name the catalog (catalogId, from view list).'))
  switch (input.view) {
    case 'list': {
      // CT-001, CT-002, CT-010 — the portfolio's own and client catalogs, segments marked; who writes each (D7, quick check).
      const read = await withNote(() => portfolioCatalogs(account, portfolioId, maxRows))
      const items: Array<Record<string, unknown>> = []
      let deep = 0
      for (const row of read.rows) {
        const readable = readableOfRow(row, portfolioId)
        if (readable && deep < MAX_DEEP_CATALOGS) {
          deep++
          items.push({ ...row, writer: await catalogWriter(account, readable) })
        } else items.push(readable ? { ...row, writer: null, writerNote: 'Not read here (more than 10 catalogs): view writer.' } : row)
      }
      return {
        ...base, ownedCount: read.owned, clientCount: read.client, items, more: read.more,
        note: 'A catalog is read only when this portfolio owns it or it is a client catalog of it. writer says who writes each catalog\'s items (the quick check: data sources and feeds; its nexusMayWriteItems is null — view writer decides, also reading items, the smart pixel and the shop).',
      }
    }
    case 'catalog': {
      // CT-003, CT-010 — one catalog's settings (SDK-only fields asked apart), and who writes it.
      const catalog = await one()
      const read = await withNote(() => oneWithFallback(connectionId, 'catalog.one', catalog.catalogId, CATALOG_DETAIL_CORE, CATALOG_DETAIL_MORE))
      const body = read.body
      const ownerRows = obj(body.business) ? await maskPortfolios([obj(body.business)!]) : []
      return {
        ...base, catalogId: catalog.catalogId, relation: catalog.relation, name: text(body.name), vertical: text(body.vertical), productCount: num(body.product_count),
        feedCount: num(body.feed_count), isSegment: bool(body.is_catalog_segment), isLocal: bool(body.is_local_catalog), owner: ownerRows[0] ?? null,
        imageSettings: tidy(body.da_display_settings ?? null), defaultImageUrl: text(body.default_image_url), fallbackImageUrls: strings(body.fallback_image_url),
        storeSettings: tidy(body.store_catalog_settings ?? null), commerceAccount: tidy(body.commerce_merchant_settings ?? null), catalogStore: tidy(body.catalog_store ?? null),
        accessExpires: text(body.user_access_expire_time), fieldsNote: read.note,
        writer: await catalogWriter(account, catalog),
        ...(body.is_catalog_segment === true ? { segmentNote: 'A catalog segment: check is_catalog_segment before building catalog ads from it (Meta errors otherwise).' } : {}),
      }
    }
    case 'writer': {
      // CT-190, CT-192 — D7: who writes the items (deep), and what Shopify manages.
      const catalog = await one()
      const writer = await catalogWriter(account, catalog, true)
      return {
        ...base, ...writer,
        shopifyFieldsNote: 'Meta publishes no list of the fields Shopify manages ("if Shopify happens to update any of the fields you\'ve included in your update-feed, then the information will be overridden"): every field of a Shopify-fed item counts as Shopify\'s. Under D7 Nexus may later add only product sets, labels (internal_label, custom_label_0…4, custom_number_0…4) or a supplementary feed — each change a person approves.',
      }
    }
    case 'data-sources': {
      // CT-095 — every data source (feeds, API sessions, partner platforms); ALL unless asked (Meta's default is PRIMARY).
      const catalog = await one()
      const read = await withNote(() => listWithFallback(connectionId, 'catalog.dataSources', `${catalog.catalogId}/data_sources`, 'id', DATA_SOURCE_MORE, { ingestion_source_type: input.sourceType ?? 'ALL' }, maxRows))
      return {
        ...base, catalogId: catalog.catalogId, sourceType: input.sourceType ?? 'ALL',
        items: read.rows.map((r) => ({ sourceId: idText(r.id), name: nameOrHost(r.name), ...hiddenNote('nameHidden', r.name), appId: idText(r.app_id), uploadType: text(r.upload_type), ingestionSourceType: text(r.ingestion_source_type), nexusApp: !!account.connection.appId && idText(r.app_id) === account.connection.appId })),
        more: read.more, fieldsNote: read.note, note: 'Meta documents the edge, not its node: name, app_id and upload_type come from Meta\'s SDK. view writer says what they mean for who writes the items (D7).',
      }
    }
    case 'segments': {
      // CT-901, CT-010 — the segments made from this catalog.
      const catalog = await one()
      const read = await withNote(() => listPaged(connectionId, 'catalog.segments', `${catalog.catalogId}/catalog_segments`, { fields: CATALOG_LIST_FIELDS }, maxRows, true))
      const rows = await checkedCatalogRows(account, portfolioId, read.rows)
      return { ...base, catalogId: catalog.catalogId, isSegment: catalog.isSegment, total: read.totalCount, items: rows, more: read.more, note: 'Segments are catalogs of their own made from a part of this one (collaborative ads); each is read only when it passes the same rule.' }
    }
    case 'event-sources': {
      // Fix A7 — pixels and apps are not masked yet (nexus_meta_links_taken has no PIXEL kind; a later step adds it).
      // CT-120 one catalog's pixels and apps; CT-932 every readable catalog's, grouped by pixel or app (Meta has no
      // "catalogs of a pixel" edge: Nexus composes it from each catalog's own list).
      if (input.catalogId) {
        const catalog = await one()
        const read = await withNote(() => listPaged(connectionId, 'catalog.eventSources', `${catalog.catalogId}/external_event_sources`, { fields: EVENT_SOURCE_FIELDS }, maxRows, true))
        return { ...base, catalogId: catalog.catalogId, total: read.totalCount, items: read.rows.map((r) => ({ sourceId: idText(r.id), name: text(r.name), sourceType: text(r.source_type) })), more: read.more }
      }
      const catalogs = await withNote(() => portfolioCatalogs(account, portfolioId, 100))
      const bySource = new Map<string, { sourceId: string; name: string | null; sourceType: string | null; catalogIds: string[] }>()
      const notRead: Array<{ catalogId: string; sentence: string }> = []
      const readable = catalogs.rows.map((r) => readableOfRow(r, portfolioId)).filter((c): c is ReadableCatalog => !!c)
      for (const catalog of readable.slice(0, MAX_DEEP_CATALOGS)) {
        const read = await part(() => listPaged(connectionId, 'catalog.eventSources', `${catalog.catalogId}/external_event_sources`, { fields: EVENT_SOURCE_FIELDS }, 100))
        if (read.notRead) notRead.push({ catalogId: catalog.catalogId, sentence: read.notRead })
        for (const r of read.value?.rows ?? []) {
          const id = idText(r.id)
          if (!id) continue
          const entry = bySource.get(id) ?? { sourceId: id, name: text(r.name), sourceType: text(r.source_type), catalogIds: [] }
          entry.catalogIds.push(catalog.catalogId)
          bySource.set(id, entry)
        }
      }
      return {
        ...base, sources: [...bySource.values()], catalogsRead: Math.min(readable.length, MAX_DEEP_CATALOGS), catalogsNotRead: Math.max(0, readable.length - MAX_DEEP_CATALOGS), notRead,
        note: 'Each pixel or app with the business\'s catalogs it is connected to (Meta has no list of a pixel\'s catalogs; Nexus reads each catalog\'s own list).',
      }
    }
    case 'people': {
      // CT-013 — people and system users assigned to the catalog (business is required by Meta: the portfolio).
      const catalog = await one()
      const read = await withNote(() => listPaged(connectionId, 'catalog.people', `${catalog.catalogId}/assigned_users`, { business: portfolioId, fields: 'id,name,user_type,tasks,permitted_tasks' }, maxRows, true))
      return {
        ...base, catalogId: catalog.catalogId, total: read.totalCount,
        items: read.rows.map((r) => ({ userId: idText(r.id), name: text(r.name), userType: text(r.user_type), tasks: strings(r.tasks), permittedTasks: strings(r.permitted_tasks) })),
        more: read.more, note: 'Giving or taking access is a change tool (a later Nexus step); a person can in Meta Business settings › Catalogs.',
      }
    }
    case 'partners': {
      // CT-016 agencies, CT-902 businesses with permission on the catalog — another Nexus business's portfolio is its id only.
      const catalog = await one()
      const agencies = await part(() => listPaged(connectionId, 'catalog.agencies', `${catalog.catalogId}/agencies`, { fields: 'id,name' }, maxRows))
      const connected = await part(() => listPaged(connectionId, 'catalog.connectedBusinesses', `${catalog.catalogId}/connected_businesses`, { fields: 'id,name' }, maxRows))
      return {
        ...base, catalogId: catalog.catalogId,
        agencies: agencies.value ? await maskPortfolios(agencies.value.rows) : { notRead: agencies.notRead },
        connectedBusinesses: connected.value ? await maskPortfolios(connected.value.rows) : { notRead: connected.notRead },
        note: 'agencies: partner businesses the catalog is shared with; connectedBusinesses: every business with a permission on it. A business portfolio another business in Nexus uses is its id only.',
      }
    }
    case 'collaborative': {
      // CT-130 the catalog's collaborative-ads share settings; CT-131 requests sent and received; CT-132 suggested
      // partners; CT-133 the portfolio's collaborative-ads set-up (SDK only: Meta's answer decides).
      const catalog = input.catalogId ? await one() : null
      const share = catalog ? await part(() => listPaged(connectionId, 'catalog.collabShare', `${catalog.catalogId}/collaborative_ads_share_settings`, { fields: 'id,agency_business{id,name},product_catalog_proxy_id,utm_source,utm_medium,utm_campaign' }, maxRows)) : null
      const requestFields = 'id,status,source,creation_time,brands,sender_business{id,name},receiver_business{id,name},catalog_segment{id,name}'
      const sent = await part(() => listPaged(connectionId, 'catalog.collabRequests.sent', `${portfolioId}/collaborative_ads_collaboration_requests`, { request_role: 'SENDER', fields: requestFields }, maxRows))
      const received = await part(() => listPaged(connectionId, 'catalog.collabRequests.received', `${portfolioId}/collaborative_ads_collaboration_requests`, { request_role: 'RECEIVER', fields: requestFields }, maxRows))
      // Fix A7 — suggested partners' brands are shown as Meta answers them (not masked; a later step).
      const suggested = await part(() => listPaged(connectionId, 'catalog.collabSuggested', `${portfolioId}/collaborative_ads_suggested_partners`, { fields: 'id,brands,countries,merchant_categories,status,status_reason' }, maxRows))
      const setup = await part(() => listWithFallback(connectionId, 'catalog.collabSetup', `${portfolioId}/cpas_business_setup_config`, 'id', 'accepted_collab_ads_tos,business_capabilities_status,capabilities_compliance_status', {}, 10))
      const merchant = await part(() => listWithFallback(connectionId, 'catalog.collabMerchant', `${portfolioId}/cpas_merchant_config`, 'id', 'accepted_tos,business_outcomes_status,is_test_merchant,outcomes_compliance_status,qualified_to_onboard', {}, 10))
      const request = async (r: Row) => {
        const [sender, receiver] = await maskPortfolios([obj(r.sender_business) ?? {}, obj(r.receiver_business) ?? {}])
        return { requestId: idText(r.id), status: text(r.status), source: text(r.source), created: text(r.creation_time), brands: strings(r.brands), sender, receiver, catalogSegment: tidy(r.catalog_segment ?? null) }
      }
      return {
        ...base, catalogId: catalog?.catalogId ?? null,
        shareSettings: share ? (share.value ? await Promise.all(share.value.rows.map(async (r) => ({ settingsId: idText(r.id), agency: obj(r.agency_business) ? (await maskPortfolios([obj(r.agency_business)!]))[0] : null, proxyCatalogId: idText(r.product_catalog_proxy_id), utm: { source: text(r.utm_source), medium: text(r.utm_medium), campaign: text(r.utm_campaign) } }))) : { notRead: share.notRead }) : null,
        requestsSent: sent.value ? await Promise.all(sent.value.rows.map(request)) : { notRead: sent.notRead },
        requestsReceived: received.value ? await Promise.all(received.value.rows.map(request)) : { notRead: received.notRead },
        suggestedPartners: suggested.value ? suggested.value.rows.map((r) => tidy(r)) : { notRead: suggested.notRead },
        setup: setup.value ? { items: setup.value.rows.map((r) => tidy(r)), fieldsNote: setup.value.note } : { notRead: setup.notRead },
        merchantSetup: merchant.value ? { items: merchant.value.rows.map((r) => tidy(r)), fieldsNote: merchant.value.note } : { notRead: merchant.notRead },
        note: 'Accepting or answering a collaboration request is in Meta Business settings only (Meta has no API for it); accepting Meta\'s collaborative-ads terms is a person\'s. People\'s contact details on requests are not read.',
      }
    }
    case 'bundle-folders': {
      // CT-905 — Meta documents the edge (no params, read only), not its node.
      const catalog = await one()
      const read = await withNote(() => listWithFallback(connectionId, 'catalog.bundleFolders', `${catalog.catalogId}/bundle_folders`, 'id', 'name,categorization_criteria,valid_labels,product_set{id,name}', {}, maxRows))
      return { ...base, catalogId: catalog.catalogId, items: read.rows.map((r) => tidy(r)), more: read.more, fieldsNote: read.note, note: 'Meta documents the edge but not what a bundle folder is used for (fields from Meta\'s SDK).' }
    }
    case 'smart-pixel': {
      // SG-121 — the smart pixel's settings (documented edge) and stats (in Meta's index; its page is not found).
      const catalog = await one()
      const settings = await part(() => listWithFallback(connectionId, 'catalog.smartPixel', `${catalog.catalogId}/smart_pixel_settings`, 'id', 'pixel{id},is_create_enabled,is_update_enabled,is_delete_enabled,allowed_domains,trusted_domains,microdata_format_precedence,is_cbb_enabled', {}, 10))
      const stats = await part(() => listPaged(connectionId, 'catalog.smartPixelStats', `${catalog.catalogId}/smart_pixel_stats`, {}, 50))
      return {
        ...base, catalogId: catalog.catalogId,
        settings: settings.value ? { items: settings.value.rows.map((r) => tidy(r)), fieldsNote: settings.value.note } : { notRead: settings.notRead },
        stats: stats.value ? stats.value.rows.map((r) => tidy(r)) : { notRead: stats.notRead },
        note: 'When the smart pixel makes or updates items from the website\'s product data, it is one more writer of this catalog (view writer counts it).',
      }
    }
    case 'page-catalogs': {
      // CT-004 — the catalogs linked to the chosen Facebook Page, each checked against the rule.
      if (!account.pageId) throw new MetaLiveRefusal(NO_PAGE)
      const read = await withNote(() => listPaged(connectionId, 'catalog.pageCatalogs', `${account.pageId}/product_catalogs`, { fields: CATALOG_LIST_FIELDS }, maxRows))
      return { ...base, pageId: account.pageId, items: await checkedCatalogRows(account, portfolioId, read.rows), more: read.more }
    }
    case 'shop-catalogs': {
      // CT-005 — the chosen Page's commerce (shop) accounts and the catalogs each uses: which catalog the shop (Shopify) uses.
      if (!account.pageId) throw new MetaLiveRefusal(NO_PAGE)
      const shops = await withNote(() => listPaged(connectionId, 'catalog.pageShops', `${account.pageId}/commerce_merchant_settings`, { fields: 'id,display_name,merchant_status' }, 5))
      const items = []
      for (const shop of shops.rows) {
        const shopId = idText(shop.id)
        if (!shopId) continue
        const read = await part(() => listPaged(connectionId, 'catalog.shopCatalogs', `${shopId}/product_catalogs`, { fields: CATALOG_LIST_FIELDS }, maxRows))
        items.push({ shopId, name: text(shop.display_name), status: text(shop.merchant_status), catalogs: read.value ? await checkedCatalogRows(account, portfolioId, read.value.rows) : { notRead: read.notRead } })
      }
      return { ...base, pageId: account.pageId, shops: items, note: 'The chosen Page\'s commerce accounts (a shop on Facebook / Instagram, e.g. made by Shopify\'s channel) and the catalogs they sell from. The shop itself: meta-commerce.' }
    }
  }
}

// ── meta-catalog-items ────────────────────────────────────────────────────────────────────────────────────────────

export const ITEM_VIEWS = ['list', 'item', 'overrides', 'channels', 'item-sets', 'item-videos', 'feed-items', 'groups', 'group', 'batch-status', 'sets-batch-status'] as const
export const ITEM_AVAILABILITY = ['in stock', 'out of stock', 'preorder', 'available for order', 'discontinued', 'pending', 'mark_as_sold', 'mark_as_expired'] as const
export const ITEM_REVIEW_STATUSES = ['pending', 'rejected', 'approved', 'outdated'] as const
export const ERROR_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const
export const OVERRIDE_TYPES = ['COUNTRY', 'LANGUAGE', 'LANGUAGE_AND_COUNTRY'] as const

export interface ItemFilter { skus?: string[] | null; groupSku?: string | null; nameContains?: string | null; availability?: string | null; reviewStatus?: string | null }

/** The product-set filter rule Nexus builds from typed args (never a caller's JSON): and of each condition asked. */
export function itemFilter(f: ItemFilter): Record<string, unknown> | null {
  const parts: Array<Record<string, unknown>> = []
  if (f.skus?.length) parts.push({ retailer_id: { is_any: [...new Set(f.skus)] } })
  if (f.groupSku) parts.push({ retailer_product_group_id: { eq: f.groupSku } })
  if (f.nameContains) parts.push({ name: { i_contains: f.nameContains } })
  if (f.availability) parts.push({ availability: { eq: f.availability } })
  if (f.reviewStatus) parts.push({ review_status: { eq: f.reviewStatus } })
  return parts.length === 0 ? null : parts.length === 1 ? parts[0] : { and: parts }
}

export interface ItemsInput extends ItemFilter {
  connectionId?: string | null
  view: typeof ITEM_VIEWS[number]
  catalogId?: string | null
  itemId?: string | null
  feedId?: string | null
  groupId?: string | null
  handle?: string | null
  errorType?: string | null
  errorPriority?: typeof ERROR_PRIORITIES[number] | null
  country?: string | null
  language?: string | null
  overrideType?: typeof OVERRIDE_TYPES[number] | null
  overrideKeys?: string[] | null
  maxRows?: number
}

export const PRICE_NOTE = 'Prices are in minor units of each item\'s own currency (priceCents: 4990 = 49.90); priceShown is Meta\'s own text. A price Nexus cannot read for sure is null (priceShown stays).'

function itemQuery(input: ItemsInput): Record<string, MetaQueryValue> {
  const filter = itemFilter(input)
  return { ...(filter ? { filter } : {}), ...(input.errorType ? { error_type: input.errorType } : {}), ...(input.errorPriority ? { error_priority: input.errorPriority } : {}) }
}

export async function liveCatalogItems(input: ItemsInput) {
  const account = await metaChosenAccount(input.connectionId)
  await catalogPortfolio(account)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 100)
  const base = { view: input.view }
  const item = async () => catalogChild(account, { kind: 'item', id: need(input.itemId ?? null, 'Name the item (itemId: Meta\'s item id, from view list; a SKU is the skus filter of view list).'), catalogId: input.catalogId })
  switch (input.view) {
    case 'list': {
      // CT-020, CT-027 (an item by SKU: the retailer_id filter), CT-111 / CT-115 by error or review status.
      const catalog = await readableCatalog(account, need(input.catalogId ?? null, 'Name the catalog (catalogId, from meta-catalogs view list).'))
      const read = await withNote(() => listPaged(connectionId, 'items.list', `${catalog.catalogId}/products`, { ...itemQuery(input), fields: ITEM_LIST_FIELDS }, maxRows, true))
      return { ...base, catalogId: catalog.catalogId, total: read.totalCount, items: read.rows.map(itemRow), more: read.more, priceNote: PRICE_NOTE }
    }
    case 'feed-items': {
      // CT-029 — the items of one feed.
      const feedId = need(input.feedId ?? null, 'Name the feed (feedId, from meta-catalog-feeds view list).')
      const { catalog } = await catalogChild(account, { kind: 'feed', id: feedId, catalogId: input.catalogId })
      const read = await withNote(() => listPaged(connectionId, 'items.feed', `${feedId}/products`, { ...itemQuery(input), fields: ITEM_LIST_FIELDS }, maxRows))
      return { ...base, catalogId: catalog.catalogId, feedId, items: read.rows.map(itemRow), more: read.more, priceNote: PRICE_NOTE }
    }
    case 'item': {
      // CT-021, CT-022 (as one country / language sees it), CT-026, CT-028, CT-176, and which feed wrote it (CT-190).
      const { id, catalog } = await item()
      if (input.country && input.language) throw new MetaLiveRefusal('Name a country or a language, not both (Meta takes one view of an item at a time).')
      const override: Record<string, MetaQueryValue> = input.country ? { override_country: input.country.toUpperCase() } : input.language ? { override_language: input.language } : {}
      const read = await withNote(() => oneWithFallback(connectionId, 'items.one', id, ITEM_DETAIL_CORE, ITEM_DETAIL_MORE, override))
      const body = read.body
      // The item's money goes out once, under the restricted keys (itemMoney); never as Meta's raw price keys.
      const rest = { ...(tidy(body) as Row) }
      delete rest.price
      delete rest.salePrice
      // Round 2 item 3 — the feed's name may be its fetch address: its host only.
      const productFeed = obj(rest.productFeed)
      if (productFeed) rest.productFeed = { ...productFeed, name: nameOrHost(productFeed.name), ...hiddenNote('nameHidden', productFeed.name) }
      const feed = obj(body.product_feed)
      return {
        ...base, catalogId: catalog.catalogId, itemId: id, ...(input.country ? { asCountry: input.country.toUpperCase() } : {}), ...(input.language ? { asLanguage: input.language } : {}),
        ...itemMoney(body), item: moneySafe(rest), fieldsNote: read.note,
        writtenBy: feed ? { feedId: idText(feed.id), name: nameOrHost(feed.name), ...hiddenNote('nameHidden', feed.name), sentence: 'A feed writes this item.' } : { feedId: null, sentence: 'No feed: an app (the API) or a shop platform writes this item; meta-catalogs view writer says which.' },
        review: {
          status: text(body.review_status), rejectionReasons: strings(body.review_rejection_reasons), perChannel: tidy(body.capability_to_review_status ?? null),
          note: body.review_status === 'rejected' ? 'Rejected items do not serve. An appeal is a change (Meta\'s additional_reviews; a later Nexus step) or Commerce Manager.' : null,
        },
        priceNote: PRICE_NOTE,
        notes: ['generatedBackgroundImages are images Meta made itself; generatedBackgroundImagesAdUsage says whether ads may use them.'],
      }
    }
    case 'overrides': {
      // CT-023 / CT-105 — the item's country and language overrides (SDK only: Meta's answer decides).
      const { id, catalog } = await item()
      const read = await withNote(() => listPaged(connectionId, 'items.overrides', `${id}/override_details`, {
        fields: 'key,type,values', ...(input.overrideType ? { type: input.overrideType } : {}), ...(input.overrideKeys?.length ? { keys: input.overrideKeys } : {}),
      }, maxRows))
      return { ...base, catalogId: catalog.catalogId, itemId: id, items: read.rows.map((r) => ({ key: text(r.key), type: text(r.type), values: moneySafe(tidy(r.values ?? null)) })), more: read.more, priceNote: 'A country override\'s price is under priceShown / salePriceShown (Meta\'s text).' }
    }
    case 'channels': {
      // CT-024 — the item's status per channel (SDK only).
      const { id, catalog } = await item()
      const read = await withNote(() => listPaged(connectionId, 'items.channels', `${id}/channels_to_integrity_status`, { fields: 'channels,rejection_information' }, 50))
      return { ...base, catalogId: catalog.catalogId, itemId: id, items: read.rows.map((r) => tidy(r)), note: 'Meta\'s SDK names this edge; its page does not. Meta\'s own answer as it is.' }
    }
    case 'item-sets': {
      // CT-025 — the product sets an item is in (the set's filter: meta-product-sets).
      const { id, catalog } = await item()
      const read = await withNote(() => listPaged(connectionId, 'items.sets', `${id}/product_sets`, { fields: 'id,name,product_count,retailer_id' }, maxRows))
      return { ...base, catalogId: catalog.catalogId, itemId: id, items: read.rows.map((r) => ({ productSetId: idText(r.id), name: text(r.name), productCount: num(r.product_count), retailerId: text(r.retailer_id) })), more: read.more }
    }
    case 'item-videos': {
      // CT-026 — the item's video fetch data (SDK only; the documented videos and video_fetch_status are in view item).
      const { id, catalog } = await item()
      const read = await withNote(() => listPaged(connectionId, 'items.videos', `${id}/videos_metadata`, { fields: 'id,url,video' }, 50))
      return { ...base, catalogId: catalog.catalogId, itemId: id, items: read.rows.map((r) => tidy(r)), note: 'Meta\'s SDK names this edge; its page does not. view item has the documented videos and video_fetch_status.' }
    }
    case 'groups': {
      // CT-050 — the item groups (variant families: the items' item_group_id).
      const catalog = await readableCatalog(account, need(input.catalogId ?? null, 'Name the catalog (catalogId, from meta-catalogs view list).'))
      const read = await withNote(() => listWithFallback(connectionId, 'items.groups', `${catalog.catalogId}/product_groups`, 'id', 'retailer_id,variants', {}, maxRows, true))
      return { ...base, catalogId: catalog.catalogId, total: read.totalCount, items: read.rows.map((r) => ({ groupId: idText(r.id), groupSku: text(r.retailer_id), variants: tidy(r.variants ?? null) })), more: read.more, fieldsNote: read.note, note: 'A group\'s groupSku is the items\' item_group_id (retailer_product_group_id), not a Meta id.' }
    }
    case 'group': {
      // CT-051 — one group and its variants (items).
      const groupId = need(input.groupId ?? null, 'Name the item group (groupId, from view groups).')
      const { id, catalog } = await catalogChild(account, { kind: 'group', id: groupId, catalogId: input.catalogId })
      const group = await withNote(() => oneWithFallback(connectionId, 'items.group', id, 'id', 'retailer_id,variants'))
      const items = await withNote(() => listPaged(connectionId, 'items.groupItems', `${id}/products`, { fields: ITEM_LIST_FIELDS }, maxRows))
      return { ...base, catalogId: catalog.catalogId, groupId: id, groupSku: text(group.body.retailer_id), variants: tidy(group.body.variants ?? null), items: items.rows.map(itemRow), more: items.more, fieldsNote: group.note, priceNote: PRICE_NOTE }
    }
    case 'batch-status': {
      // CT-040 — what became of an items_batch / localized_items_batch (status Scheduled → Dispatched → Started → Finished,
      // or Canceled / Error); the invalid ids only with load_ids_of_invalid_requests=true.
      const catalog = await readableCatalog(account, need(input.catalogId ?? null, 'Name the catalog the batch went to (catalogId).'))
      const handle = need(input.handle ?? null, 'Name the batch handle (handle, from the batch\'s answer).')
      const read = await withNote(() => metaReadOne({ connectionId }, { operation: 'items.batchStatus', path: `${catalog.catalogId}/check_batch_request_status`, query: { handle, load_ids_of_invalid_requests: true, fields: 'handle,status,errors,errors_total_count,warnings,warnings_total_count,ids_of_invalid_requests' } }))
      return {
        ...base, catalogId: catalog.catalogId, items: list(read.body).map((r) => ({ handle: text(r.handle), status: text(r.status), errorsTotal: num(r.errors_total_count), warningsTotal: num(r.warnings_total_count), errors: tidy(r.errors ?? null), warnings: tidy(r.warnings ?? null), invalidRequestIds: tidy(r.ids_of_invalid_requests ?? null) })),
        note: 'Finished means done: requests with errors were NOT saved (errors and warnings are samples; the totals count them all).',
      }
    }
    case 'sets-batch-status': {
      // CT-069a — a product-sets batch's result (reading only: Meta documents no way to send one).
      const catalog = await readableCatalog(account, need(input.catalogId ?? null, 'Name the catalog the batch went to (catalogId).'))
      const handle = need(input.handle ?? null, 'Name the batch handle (handle).')
      const read = await withNote(() => listPaged(connectionId, 'items.setsBatchStatus', `${catalog.catalogId}/product_sets_batch`, { handle, fields: 'handle,status,errors,errors_total_count' }, 10))
      return { ...base, catalogId: catalog.catalogId, items: read.rows.map((r) => ({ handle: text(r.handle), status: text(r.status), errorsTotal: num(r.errors_total_count), errors: tidy(r.errors ?? null) })) }
    }
  }
}

// ── meta-catalog-feeds ────────────────────────────────────────────────────────────────────────────────────────────

export const FEED_VIEWS = ['list', 'feed', 'schedules', 'uploads', 'upload', 'upload-errors', 'suggested-rules', 'rules'] as const

export interface FeedsInput { connectionId?: string | null; view: typeof FEED_VIEWS[number]; catalogId?: string | null; feedId?: string | null; uploadId?: string | null; errorId?: string | null; errorPriority?: typeof ERROR_PRIORITIES[number] | null; maxRows?: number }

export async function liveCatalogFeeds(input: FeedsInput) {
  const account = await metaChosenAccount(input.connectionId)
  await catalogPortfolio(account)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 50)
  const base = { view: input.view }
  const feedId = () => need(input.feedId ?? null, 'Name the feed (feedId, from view list).')
  const uploadId = () => need(input.uploadId ?? null, 'Name the upload (uploadId, from view uploads).')
  switch (input.view) {
    case 'list': {
      // CT-070, CT-080 — the catalog's feeds with their schedules and latest upload.
      const catalog = await readableCatalog(account, need(input.catalogId ?? null, 'Name the catalog (catalogId, from meta-catalogs view list).'))
      const read = await withNote(() => listPaged(connectionId, 'feeds.list', `${catalog.catalogId}/product_feeds`, { fields: FEED_LIST_FIELDS }, maxRows))
      return { ...base, catalogId: catalog.catalogId, items: read.rows.map(feedOf), more: read.more, note: 'schedule = full replace (items missing from the file are deleted when deletion is on); updateSchedule = add and update only. A schedule without a time zone: Meta does not say which one it uses (timeZone null). Fetch addresses are shown by host only (they may hold a key).' }
    }
    case 'feed': {
      // CT-071, CT-080 — one feed (SDK-only fields asked apart).
      const { id, catalog } = await catalogChild(account, { kind: 'feed', id: feedId(), catalogId: input.catalogId })
      const read = await withNote(() => oneWithFallback(connectionId, 'feeds.one', id, FEED_DETAIL_CORE, FEED_DETAIL_MORE))
      const b = read.body
      return {
        ...base, catalogId: catalog.catalogId, ...feedOf(b), delimiter: text(b.delimiter), encoding: text(b.encoding), quotedFieldsMode: text(b.quoted_fields_mode), itemSubType: text(b.item_sub_type),
        migratedFromFeedId: idText(b.migrated_from_feed_id), primaryFeeds: strings(b.primary_feeds), supplementaryFeeds: strings(b.supplementary_feeds),
        fieldsNote: read.note,
      }
    }
    case 'schedules': {
      // CT-081 — the feed's extra upload schedules (each adds and updates only, never deletes).
      const { id, catalog } = await catalogChild(account, { kind: 'feed', id: feedId(), catalogId: input.catalogId })
      const read = await withNote(() => listPaged(connectionId, 'feeds.schedules', `${id}/upload_schedules`, { fields: `id,${SCHEDULE_FIELDS}` }, maxRows))
      return { ...base, catalogId: catalog.catalogId, feedId: id, items: read.rows.map((r) => ({ scheduleId: idText(r.id), ...scheduleOf(r) })), more: read.more, note: 'Extra schedules only add and update items (meant for price and availability); the feed\'s own schedule is in view feed. Changing them is a change tool (a later Nexus step).' }
    }
    case 'uploads': {
      // CT-072 — the feed's uploads, manual and scheduled.
      const { id, catalog } = await catalogChild(account, { kind: 'feed', id: feedId(), catalogId: input.catalogId })
      const read = await withNote(() => listPaged(connectionId, 'feeds.uploads', `${id}/uploads`, { fields: UPLOAD_FIELDS }, maxRows))
      return { ...base, catalogId: catalog.catalogId, feedId: id, items: read.rows.map(uploadOf), more: read.more }
    }
    case 'upload': {
      // CT-073 — one upload's result.
      const { id, catalog } = await catalogChild(account, { kind: 'upload', id: uploadId(), catalogId: input.catalogId, feedId: input.feedId })
      const read = await withNote(() => oneWithFallback(connectionId, 'feeds.upload', id, UPLOAD_FIELDS, 'error_report'))
      return { ...base, catalogId: catalog.catalogId, feedId: input.feedId, upload: uploadOf(read.body), errorReport: errorReportOf(read.body.error_report), fieldsNote: read.note }
    }
    case 'upload-errors': {
      // CT-086 — a sample of an upload's errors and warnings (fatal: the item was not made; warning: made anyway).
      const { id, catalog } = await catalogChild(account, { kind: 'upload', id: uploadId(), catalogId: input.catalogId, feedId: input.feedId })
      const read = await withNote(() => listWithFallback(connectionId, 'feeds.uploadErrors', `${id}/errors`, 'id,summary,description,severity,error_type,affected_surfaces', 'total_count', input.errorPriority ? { error_priority: input.errorPriority } : {}, maxRows, true))
      return {
        ...base, catalogId: catalog.catalogId, feedId: input.feedId, uploadId: id, total: read.totalCount,
        items: read.rows.map((r) => ({ errorId: idText(r.id), summary: text(r.summary), description: text(r.description), severity: text(r.severity), errorType: text(r.error_type), affectedSurfaces: strings(r.affected_surfaces), rows: num(r.total_count) })),
        fieldsNote: read.note,
        more: read.more, note: 'A sample (not every row); rows is how many rows of the file had that error (Meta\'s total_count, SDK only). fatal: the item was not made; warning: made anyway. The rest of the file still loads. errorPriority HIGH = fatal only; MEDIUM or LOW = every warning.',
      }
    }
    case 'suggested-rules': {
      // CT-091 — Meta's suggested rules for one upload error.
      const errorId = need(input.errorId ?? null, 'Name the error (errorId, from view upload-errors).')
      const { id, catalog } = await catalogChild(account, { kind: 'upload_error', id: errorId, catalogId: input.catalogId, feedId: input.feedId, uploadId: input.uploadId })
      const read = await withNote(() => listPaged(connectionId, 'feeds.suggestedRules', `${id}/suggested_rules`, { fields: 'attribute,params,type' }, 50))
      return { ...base, catalogId: catalog.catalogId, errorId: id, items: read.rows.map((r) => ({ attribute: text(r.attribute), type: text(r.type), params: tidy(r.params ?? null) })), note: 'Applying a suggested rule is a change (a later Nexus step).' }
    }
    case 'rules': {
      // CT-082 — the feed's rules (mapping, value and fix rules).
      const { id, catalog } = await catalogChild(account, { kind: 'feed', id: feedId(), catalogId: input.catalogId })
      const read = await withNote(() => listPaged(connectionId, 'feeds.rules', `${id}/rules`, { fields: 'id,attribute,rule_type,params' }, maxRows))
      return { ...base, catalogId: catalog.catalogId, feedId: id, items: read.rows.map((r) => ({ ruleId: idText(r.id), attribute: text(r.attribute), ruleType: text(r.rule_type), params: tidy(r.params ?? null) })), more: read.more }
    }
  }
}

// ── meta-catalog-health ───────────────────────────────────────────────────────────────────────────────────────────

export const HEALTH_VIEWS = ['readiness', 'diagnostics', 'problem-items', 'rejected', 'match-rate', 'pixel-checks', 'eligible-accounts'] as const
export const DIAGNOSTIC_TYPES = ['AR_VISIBILITY_ISSUES', 'ATTRIBUTES_INVALID', 'ATTRIBUTES_MISSING', 'CATEGORY', 'CHECKOUT', 'DA_VISIBILITY_ISSUES', 'EVENT_SOURCE_ISSUES', 'IMAGE_QUALITY', 'LOW_QUALITY_TITLE_AND_DESCRIPTION', 'POLICY_VIOLATION', 'SHOPS_VISIBILITY_ISSUES'] as const
export const DIAGNOSTIC_SEVERITIES = ['MUST_FIX', 'OPPORTUNITY'] as const
export const DIAGNOSTIC_CHANNELS = ['b2c_marketplace', 'c2c_marketplace', 'da', 'daily_deals', 'daily_deals_legacy', 'ig_product_tagging', 'marketplace', 'marketplace_ads_deprecated', 'marketplace_shops', 'mini_shops', 'offline_conversions', 'shops', 'universal_checkout', 'whatsapp'] as const
export const DIAGNOSTIC_ENTITIES = ['product_item', 'product_catalog', 'product_set', 'product_event'] as const
export const DA_CHECKS = ['pixel_missing_param_in_events', 'pixel_decline'] as const
export const CONNECTION_METHODS = ['ALL', 'APP', 'BROWSER', 'SERVER'] as const

export interface HealthInput {
  connectionId?: string | null
  view: typeof HEALTH_VIEWS[number]
  catalogId?: string | null
  sourceId?: string | null
  types?: string[] | null
  severities?: string[] | null
  channels?: string[] | null
  entities?: string[] | null
  errorType?: string | null
  errorPriority?: typeof ERROR_PRIORITIES[number] | null
  byDevice?: boolean
  checks?: string[] | null
  connectionMethod?: typeof CONNECTION_METHODS[number] | null
  maxRows?: number
}

const TIER_NOTE = 'Meta answers this read only to apps with full (Advanced) Marketing API access (error 270 on development access); the Owner raises the access tier in Meta\'s App Dashboard after enough calls.'

/** A read Meta may refuse for the access tier (error 270): said plainly. */
async function withTier<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await withNote(work)
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && /^270(\/|$)/.test(err.failure.code ?? '')) throw new MetaLiveRefusal(`${err.message} ${TIER_NOTE}`)
    throw err
  }
}

function diagnosticOf(r: Row) {
  return {
    title: text(r.title), subtitle: text(r.subtitle), type: text(r.type), severity: text(r.severity), errorCode: num(r.error_code), affectedItems: num(r.number_of_affected_items),
    affectedEntities: num(r.number_of_affected_entities), affectedChannels: strings(r.affected_channels), affectedEntity: text(r.affected_entity), affectedFeatures: strings(r.affected_features),
    details: tidy(r.diagnostics ?? null),
  }
}

/** event_stats rows → per event source: matched and unmatched content ids, and the matched share (CT-934's ranking). */
function rankSources(rows: Row[]) {
  const by = new Map<string, { sourceId: string; name: string | null; sourceType: string | null; matched: number; unmatched: number; matchedOtherCatalogs: number; events: Set<string> }>()
  for (const r of rows) {
    const source = obj(r.event_source)
    const id = idText(source?.id) ?? idText(r.event_source)
    if (!id) continue
    const entry = by.get(id) ?? { sourceId: id, name: text(source?.name), sourceType: text(source?.source_type), matched: 0, unmatched: 0, matchedOtherCatalogs: 0, events: new Set<string>() }
    entry.matched += num(r.total_matched_content_ids) ?? 0
    entry.unmatched += num(r.total_unmatched_content_ids) ?? 0
    entry.matchedOtherCatalogs += num(r.total_content_ids_matched_other_catalogs) ?? 0
    const event = text(r.event)
    if (event) entry.events.add(event)
    by.set(id, entry)
  }
  return [...by.values()]
    .map((e) => ({ sourceId: e.sourceId, name: e.name, sourceType: e.sourceType, matched: e.matched, unmatched: e.unmatched, matchedOtherCatalogs: e.matchedOtherCatalogs, events: [...e.events], matchedShare: e.matched + e.unmatched > 0 ? Math.round((e.matched / (e.matched + e.unmatched)) * 1000) / 1000 : null }))
    .sort((a, b) => (b.matchedShare ?? -1) - (a.matchedShare ?? -1) || b.matched - a.matched)
}

const REJECTED = { review_status: { eq: 'rejected' } }

/** Fix B5 — is the chosen ad account among those that may run catalog ads with it? Meta's search by the account id. */
async function chosenEligible(account: MetaChosenAccount, catalogId: string): Promise<true | null> {
  const read = await listPaged(account.connectionId, 'health.eligibleChosen', `${catalogId}/dpa_eligible_ad_accounts`, { fields: 'id,account_id', search: account.adAccountId }, 25)
  // Round 2 item 6 — "the search found nothing" is not proof until probe CT-900a shows Meta's search finds an account by
  // its id: null (not known), never false.
  return read.rows.some((r) => metaAdAccountId(r.account_id ?? r.id) === account.adAccountId) ? true : null
}

export async function liveCatalogHealth(input: HealthInput) {
  const account = await metaChosenAccount(input.connectionId)
  await catalogPortfolio(account)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 100)
  const catalog = await readableCatalog(account, need(input.catalogId ?? null, 'Name the catalog (catalogId, from meta-catalogs view list).'))
  const base = { view: input.view, catalogId: catalog.catalogId }
  switch (input.view) {
    case 'diagnostics': {
      // CT-110 — what is wrong, how many items, how bad (EVENT_SOURCE_ISSUES is updated daily).
      const read = await withNote(() => listPaged(connectionId, 'health.diagnostics', `${catalog.catalogId}/diagnostics`, {
        fields: DIAGNOSTIC_FIELDS, ...(input.types?.length ? { types: input.types } : {}), ...(input.severities?.length ? { severities: input.severities } : {}),
        ...(input.channels?.length ? { affected_channels: input.channels } : {}), ...(input.entities?.length ? { affected_entities: input.entities } : {}),
      }, maxRows))
      return { ...base, items: read.rows.map(diagnosticOf), more: read.more, note: 'MUST_FIX stops items from serving on the channels named; OPPORTUNITY would improve them. Event source issues are updated once a day. The items behind a problem: view problem-items.' }
    }
    case 'problem-items': {
      // CT-111 — the items behind one problem, worst first (priority mixes how bad the issue is and how important the item is).
      const read = await withNote(() => listPaged(connectionId, 'health.problemItems', `${catalog.catalogId}/products`, {
        fields: ITEM_HEALTH_FIELDS, error_priority: input.errorPriority ?? 'HIGH', ...(input.errorType ? { error_type: input.errorType } : {}),
      }, maxRows, true))
      return { ...base, errorPriority: input.errorPriority ?? 'HIGH', errorType: input.errorType ?? null, total: read.totalCount, items: read.rows.map(healthItemRow), more: read.more, note: 'Prices: meta-catalog-items. Priority mixes how bad the issue is and how important the item is.' }
    }
    case 'rejected': {
      // CT-115 — rejected items and why (they do not serve).
      const read = await withNote(() => listPaged(connectionId, 'health.rejected', `${catalog.catalogId}/products`, { fields: ITEM_HEALTH_FIELDS, filter: REJECTED }, maxRows, true))
      return { ...base, total: read.totalCount, items: read.rows.map(healthItemRow), more: read.more, note: 'Rejected items do not serve. An appeal is a change (Meta\'s additional_reviews: at most 100 items a call, 10 calls a day; a later Nexus step) or Commerce Manager.' }
    }
    case 'match-rate': {
      // CT-112 — how pixel and app events match the catalog's items (per day; counts not de-duplicated; Meta does not say
      // over how many days — fix B4);
      // CT-934 — Meta has no public "recommended event sources" call: Nexus ranks the sources Meta reports by matched share.
      const read = await withTier(() => listPaged(connectionId, 'health.eventStats', `${catalog.catalogId}/event_stats`, { fields: EVENT_STAT_FIELDS, ...(input.byDevice ? { breakdowns: ['DEVICE_TYPE'] } : {}) }, 500))
      return {
        ...base, sourcesRanked: rankSources(read.rows), rows: read.rows.map((r) => ({ ...(tidy(r) as Row) })), more: read.more,
        note: 'Meta\'s numbers per day and per event source (Meta does not say over how many days); counts are not de-duplicated, and only sources this system user can see appear. An unmatched content id is an event whose product id is not in this catalog (pixel content_ids must equal the items\' ids). sourcesRanked: Nexus\'s ranking by matched share (Meta\'s own MCP recommends sources; Meta has no public API for it). A dataset not yet connected to the catalog: meta-datasets lists the business\'s datasets; connecting one is a change (a later Nexus step).',
      }
    }
    case 'pixel-checks': {
      // CT-113 — Meta's catalog-ads checks on one pixel or app connected to this catalog.
      const sourceId = need(input.sourceId ?? null, 'Name the pixel or app (sourceId, from meta-catalogs view event-sources).')
      const { id } = await catalogChild(account, { kind: 'event_source', id: sourceId, catalogId: catalog.catalogId })
      const read = await withNote(() => listPaged(connectionId, 'health.daChecks', `${id}/da_checks`, { fields: 'key,title,description,result,user_message,action_uri', ...(input.checks?.length ? { checks: input.checks } : {}), ...(input.connectionMethod ? { connection_method: input.connectionMethod } : {}) }, 50))
      return { ...base, sourceId: id, items: read.rows.map((r) => ({ key: text(r.key), title: text(r.title), result: text(r.result), description: text(r.description), message: text(r.user_message), actionUrl: text(r.action_uri) })) }
    }
    case 'eligible-accounts': {
      // CT-900 — the ad accounts that may run catalog ads with this catalog; is the chosen one among them?
      const read = await withNote(() => listPaged(connectionId, 'health.eligibleAccounts', `${catalog.catalogId}/dpa_eligible_ad_accounts`, { fields: 'id,account_id,name' }, maxRows))
      // Fix B5 — whether the chosen account is eligible: Meta's own search by its id, not a scan of the list.
      const chosen = await chosenEligible(account, catalog.catalogId)
      const taken = await takenIds('AD_ACCOUNT', read.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id))
      const items = read.rows.map((r) => {
        const id = metaAdAccountId(r.account_id ?? r.id)
        return id && taken.has(id) ? { adAccountId: id, takenByAnotherBusiness: true } : { adAccountId: id, name: text(r.name), chosenHere: id === account.adAccountId, takenByAnotherBusiness: false }
      })
      return { ...base, chosenAccountEligible: chosen ?? (items.some((i) => (i as { chosenHere?: boolean }).chosenHere === true) ? true : null), items, more: read.more, note: 'chosenAccountEligible: true when Meta lists the chosen account; null when its search did not find it (not known, not a no).' }
    }
    case 'readiness': {
      // CT-114 — one "is this catalog ready for catalog ads?" answer, composed from Meta's own reads (each may fail alone).
      const blockers: string[] = []
      const warnings: string[] = []
      if (catalog.productCount === 0) blockers.push('The catalog has no items.')
      if (catalog.isSegment) warnings.push('A catalog segment: catalog ads must be built from it as a segment.')
      const diagnostics = await part(() => listPaged(connectionId, 'health.readiness.diagnostics', `${catalog.catalogId}/diagnostics`, { fields: DIAGNOSTIC_FIELDS, severities: ['MUST_FIX'] }, 100))
      for (const d of diagnostics.value?.rows ?? []) blockers.push(`${text(d.title) ?? text(d.type) ?? 'A problem'}${num(d.number_of_affected_items) !== null ? ` (${num(d.number_of_affected_items)} items)` : ''}.`)
      const rejected = await part(() => listPaged(connectionId, 'health.readiness.rejected', `${catalog.catalogId}/products`, { fields: 'id', filter: REJECTED }, 1, true))
      const rejectedCount = rejected.value ? rejected.value.totalCount ?? rejected.value.rows.length : null
      if (rejectedCount) warnings.push(`${rejectedCount} item(s) rejected in review (they do not serve).`)
      const sources = await part(() => listPaged(connectionId, 'health.readiness.eventSources', `${catalog.catalogId}/external_event_sources`, { fields: EVENT_SOURCE_FIELDS }, 20))
      if (sources.value && sources.value.rows.length === 0) blockers.push('No pixel or app is connected to the catalog: catalog ads that show people what they viewed need one.')
      const stats = await part(() => withTier(() => listPaged(connectionId, 'health.readiness.eventStats', `${catalog.catalogId}/event_stats`, { fields: EVENT_STAT_FIELDS }, 500)))
      const ranked = stats.value ? rankSources(stats.value.rows) : []
      for (const s of ranked) if (s.matchedShare !== null && s.matchedShare < 0.9) warnings.push(`Event source ${s.sourceId}: only ${Math.round(s.matchedShare * 100)}% of its product ids match this catalog's items.`)
      const checks: Array<{ sourceId: string; items: unknown; notRead: string | null }> = []
      for (const s of (sources.value?.rows ?? []).slice(0, 3)) {
        const sid = idText(s.id)
        if (!sid) continue
        const read = await part(() => listPaged(connectionId, 'health.readiness.daChecks', `${sid}/da_checks`, { fields: 'key,title,result,user_message' }, 20))
        for (const c of read.value?.rows ?? []) if (text(c.result) && !/pass/i.test(String(c.result))) warnings.push(`Check "${text(c.title) ?? text(c.key)}" on ${sid}: ${text(c.result)}${text(c.user_message) ? ` — ${text(c.user_message)}` : ''}.`)
        checks.push({ sourceId: sid, items: read.value ? read.value.rows.map((r) => tidy(r)) : null, notRead: read.notRead })
      }
      const feeds = await part(() => listPaged(connectionId, 'health.readiness.feeds', `${catalog.catalogId}/product_feeds`, { fields: `id,name,latest_upload{${UPLOAD_FIELDS}}` }, 50))
      for (const f of feeds.value?.rows ?? []) {
        const u = uploadOf(f.latest_upload)
        // Round 5 item 5 — a feed with no name shown and no id is "A feed", never "Feed null".
        const label = nameOrHost(f.name) ?? idText(f.id)
        const feedWord = label ? `Feed ${label}` : 'A feed'
        if (u?.errors) warnings.push(`${feedWord}: its latest upload had ${u.errors} error(s).`)
        if (u?.itemsDeleted) warnings.push(`${feedWord}: its latest upload deleted ${u.itemsDeleted} item(s).`)
      }
      const eligible = await part(() => chosenEligible(account, catalog.catalogId))
      const chosenIsEligible = eligible.value ?? null
      if (eligible.value === null && !eligible.notRead) warnings.push('Meta\'s search of the eligible ad accounts did not find the chosen one by its id; whether it may run catalog ads with this catalog is not known yet (meta-catalog-health view eligible-accounts lists them).')
      const writer = await catalogWriter(account, catalog)
      const notRead = Object.entries({ diagnostics, rejected, eventSources: sources, eventStats: stats, feeds, eligibleAccounts: eligible }).filter(([, p]) => p.notRead).map(([name, p]) => ({ part: name, sentence: p.notRead }))
      return {
        ...base, ready: notRead.length ? (blockers.length ? false : null) : blockers.length === 0, blockers, warnings, rejectedItems: rejectedCount, chosenAccountEligible: chosenIsEligible,
        eventSources: sources.value ? sources.value.rows.map((r) => ({ sourceId: idText(r.id), name: text(r.name), sourceType: text(r.source_type) })) : null, sourcesRanked: ranked, checks,
        writer, notRead,
        note: 'ready is true only when every part was read and nothing blocks; null when a part could not be read. Meta\'s own MCP has one health tool; Nexus composes the same answer from Meta\'s reads.',
      }
    }
  }
}
