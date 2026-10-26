/**
 * Meta ads step 35 (2026-10-25) — what the item and feed changes read LIVE before they are drafted (GET only, through the
 * gateway), and the D7 write checks they run (at the preview and again when the approved change runs — the builder runs
 * twice — and the gateway runs them a third time: gateway/meta-catalog-items-owner.ts):
 *
 *   itemsWriteCheck   items_batch, localized items, an item group's default: step 12's writableCatalog(…, 'items') —
 *                     nexusMayWriteItems === true, never on a segment (step 34's writableFor wording: "Shopify owns these
 *                     items" first on a Shopify catalog).
 *   d7WriteCheck      a labels upload: writableCatalog(…, { upload: [id, …D7 columns], ownFeedIds }); feed rules on a D7
 *                     column: { rules: [attribute], ownFeedIds }.
 *   feedWriteCheck    a feed that brings items, a change of one, a URL or full-file upload, an upload schedule, a rule on
 *                     another field: writableCatalog(…, 'items') — or, once Nexus made the catalog's feed itself, the catalog
 *                     is written by Nexus ALONE (every writer Meta names is Nexus's own app or a feed Nexus made: its own
 *                     change records, never a caller's ids), nothing unread, not a segment, owned and shared with no other
 *                     Nexus business (step 12's write rule, which counts every feed as "a data feed writes these items").
 *
 * Own feeds (ownCatalogFeedIds): the feeds set-meta-catalog-feed made on THIS catalog of THIS business's chosen ad account,
 * from Nexus's own change records (AgentChange, row-level security keeps them this business's), not undone.
 *
 * Reads reuse step 12's and step 34's readers; an item is read under Meta's READ names (SDK productitem.py) and turned into
 * the WRITE names a change sends (writeStateOf), each value or null (Meta has none) or undefined (Nexus cannot read it back
 * exactly: undo says so).
 */
import prisma from '../../../db.js'
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { listPaged } from './paging.js'
import { catalogChild, writableCatalog, D7_KEY_COLUMN, D7_NEXUS_COLUMNS, type CatalogWriter, type ReadableCatalog } from './catalog-rule.js'
import { writableFor } from './live-catalog-admin.js'
import { catalogPriceMinor } from './live-catalog.js'
import { currencyExponent } from './money.js'
import { META_ITEM_AVAILABILITY, META_ITEM_CONDITIONS, META_ITEM_D7_FIELDS, META_ITEM_STATE_FIELDS, metaDayOk, metaInternalLabelOk, type MetaOverrideType } from '../../gateway/meta-catalog-items-rules.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [])

// ── the D7 write checks ─────────────────────────────────────────────────────────────────────────────────────────────

/** The tool whose records name the feeds Nexus made. */
export const FEED_TOOL = 'set-meta-catalog-feed'

/**
 * The feeds set-meta-catalog-feed made on this catalog of this ad account (its own records), not undone, each with the kind
 * it was made as (products, supplementary, offers, …: Meta reads no feed_type back, so the record says it — review B-F5).
 */
export async function ownCatalogFeeds(catalogId: string, adAccountId: string): Promise<Map<string, string | null>> {
  // Re-review nit (a): only creates are read (labels and other records never push a feed Nexus made out of the 500).
  const rows = await prisma.agentChange.findMany({ where: { toolName: FEED_TOOL, undoneAt: null, after: { path: ['op'], equals: 'create' } }, select: { after: true }, orderBy: { executedAt: 'desc' }, take: 500 })
  const feeds = new Map<string, string | null>()
  for (const row of rows) {
    const after = obj(row.after)
    if (!after || after.op !== 'create' || after.catalogId !== catalogId || after.adAccountId !== adAccountId) continue
    const id = metaObjectId(after.feedId)
    if (id && !feeds.has(id)) feeds.set(id, typeof after.kind === 'string' ? after.kind : null)
  }
  return feeds
}

/** The ids of those feeds. */
export async function ownCatalogFeedIds(catalogId: string, adAccountId: string): Promise<string[]> {
  return [...(await ownCatalogFeeds(catalogId, adAccountId)).keys()]
}

/** step 34's writableFor ('items'), with its Shopify sentence: items_batch, localized items, a group's default item. */
export async function itemsWriteCheck(account: MetaChosenAccount, catalogId: string): Promise<{ catalog: ReadableCatalog; writer: CatalogWriter }> {
  return writableFor(account, catalogId, 'items')
}

/** Every column of a labels file (id + D7 columns), checked by step 12's { upload } purpose. */
export async function d7WriteCheck(account: MetaChosenAccount, catalogId: string, columns: readonly string[], ownFeedIds: readonly string[]): Promise<{ catalog: ReadableCatalog; writer: CatalogWriter; fields: readonly string[] }> {
  const checked = await guardedWrite(() => writableCatalog(account, catalogId, { upload: columns, ownFeedIds }))
  return { catalog: checked.catalog, writer: checked.writer, fields: checked.fields ?? [] }
}

/** Feed rules on these attributes (each a D7 column), checked by step 12's { rules } purpose. */
export async function d7RulesCheck(account: MetaChosenAccount, catalogId: string, attributes: readonly string[], ownFeedIds: readonly string[]): Promise<{ catalog: ReadableCatalog; writer: CatalogWriter }> {
  const checked = await guardedWrite(() => writableCatalog(account, catalogId, { rules: attributes, ownFeedIds }))
  return { catalog: checked.catalog, writer: checked.writer }
}

async function guardedWrite<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError) throw new MetaLiveRefusal(`Nexus could not check that this catalog is the business's (${err.message}), so it changes nothing.`)
    throw err
  }
}

/**
 * Nexus ALONE writes this catalog's items: every writer Meta names is Nexus's own app or one of the feeds Nexus made, and
 * Nexus read everything (step 12's writer view, deep). Null when so, else the sentence.
 */
export function nexusAloneProblem(catalog: ReadableCatalog, writer: CatalogWriter, ownFeedIds: readonly string[]): string | null {
  if (catalog.isSegment !== false) return 'This catalog is a segment of another catalog (or Meta does not say whether it is one): its items live in the parent catalog, so Nexus writes no items or feeds here.'
  if (writer.ownership !== 'owned') return writer.sentence
  if (writer.notRead.length) return `Nexus could not read everything that writes this catalog (${writer.notRead.join(' ')}), so it changes no feed that brings items.`
  const own = new Set(ownFeedIds)
  const foreign = writer.evidence.filter((e) => !((e.kind === 'feed' && e.id && own.has(e.id)) || (e.kind === 'api' && e.nexusApp === true)))
  if (foreign.length) {
    const shopify = foreign.some((e) => e.kind === 'shopify')
    return `${shopify ? 'Shopify owns these items: only the D7 columns (labels, custom labels and numbers) are added here, by a labels upload. ' : ''}${writer.sentence} Nexus changes a feed that brings items only on a catalog it writes alone (its own app, or feeds it made: ${foreign.map((e) => `${e.from} ${e.id ?? 'without id'} (${e.kind})`).join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not).`
  }
  return null
}

/**
 * A feed that brings items (create, change, URL or full-file upload, upload schedule, a rule on a non-D7 field): step 12's
 * 'items' purpose — or Nexus alone writes the catalog (its own app and its own feeds). The refusal keeps step 12's words.
 */
export async function feedWriteCheck(account: MetaChosenAccount, catalogId: string, ownFeedIds: readonly string[]): Promise<{ catalog: ReadableCatalog; writer: CatalogWriter }> {
  const checked = await guardedWrite(() => writableCatalog(account, catalogId, 'settings'))
  if (checked.catalog.isSegment !== false) throw new MetaLiveRefusal('This catalog is a segment of another catalog (or Meta does not say whether it is one): its items live in the parent catalog, so Nexus makes or changes no feed of items here.')
  if (checked.writer.nexusMayWriteItems === true) return { catalog: checked.catalog, writer: checked.writer }
  const problem = nexusAloneProblem(checked.catalog, checked.writer, ownFeedIds)
  if (problem) throw new MetaLiveRefusal(problem)
  return { catalog: checked.catalog, writer: checked.writer }
}

// ── items, in the WRITE names ───────────────────────────────────────────────────────────────────────────────────────

/** Minor units → Meta's catalog price text: "49.90 EUR", "490 JPY" (no symbol, a period, the code). Null when not whole. */
export function catalogPriceText(minor: number | null | undefined, currency: string | null | undefined): string | null {
  if (minor === null || minor === undefined || !Number.isSafeInteger(minor) || minor < 0 || !currency || !/^[A-Z]{3}$/.test(currency)) return null
  const exp = currencyExponent(currency)
  if (exp === 0) return `${minor} ${currency}`
  const per = 10 ** exp
  return `${Math.floor(minor / per)}.${String(minor % per).padStart(exp, '0')} ${currency}`
}

/** An ISO time Meta reads back → the sale window's form (2026-11-01T00:00+0000), or null. */
function windowEnd(v: unknown): string | null {
  const t = text(v)
  if (!t) return null
  const ms = Date.parse(t)
  if (!Number.isFinite(ms)) return null
  return `${new Date(ms).toISOString().slice(0, 16)}+0000`
}

/**
 * An item's write fields as Meta READS them (SDK productitem.py names): value, null (Meta has none), or undefined (Nexus
 * cannot read it back exactly — google_product_category, shipping, video, ratings, an unparsed price or date).
 */
export function writeStateOf(r: Row): Record<string, unknown> {
  const currency = text(r.currency)
  const price = (v: unknown) => (text(v) === null ? null : catalogPriceText(catalogPriceMinor(v, currency), currency) ?? undefined)
  const enumOf = (v: unknown, allowed: readonly string[]) => (text(v) === null ? null : allowed.includes(String(v)) ? v : undefined)
  const start = r.sale_price_start_date
  const end = r.sale_price_end_date
  const window = text(start) === null && text(end) === null ? null : windowEnd(start) && windowEnd(end) ? `${windowEnd(start)}/${windowEnd(end)}` : undefined
  const images = [text(r.image_url), ...strings(r.additional_image_urls)].filter((u): u is string => !!u)
  const variants = obj(r.additional_variant_attributes)
  const variantText = variants && Object.values(variants).every((v) => typeof v === 'string')
    ? Object.entries(variants).map(([k, v]) => `${k}:${v}`).join(',') : r.additional_variant_attributes === undefined || r.additional_variant_attributes === null ? null : undefined
  const tags = Array.isArray(r.tags) ? strings(r.tags) : r.tags === undefined || r.tags === null ? [] : undefined
  const visibility = text(r.visibility)
  const weight = num(r.shipping_weight_value)
  const unit = text(r.shipping_weight_unit)
  const address = obj(r.importer_address)
  const out: Record<string, unknown> = {
    title: text(r.name), description: text(r.description), rich_text_description: text(r.rich_text_description),
    availability: enumOf(r.availability, META_ITEM_AVAILABILITY), condition: enumOf(r.condition, META_ITEM_CONDITIONS),
    price: price(r.price), sale_price: price(r.sale_price), sale_price_effective_date: window,
    link: text(r.url), mobile_link: text(r.mobile_link), image: images.length ? images.map((url) => ({ url })) : null,
    brand: text(r.brand), gtin: text(r.gtin), mpn: text(r.manufacturer_part_number), fb_product_category: text(r.fb_product_category), product_type: text(r.product_type),
    item_group_id: text(r.retailer_product_group_id), size: text(r.size), color: text(r.color), material: text(r.material), pattern: text(r.pattern),
    gender: text(r.gender), age_group: text(r.age_group), additional_variant_attribute: variantText,
    internal_label: tags && tags.every(metaInternalLabelOk) ? tags : undefined,
    disabled_capabilities: strings(r.capabilities_disabled_by_user),
    status: visibility === null ? null : visibility === 'published' ? 'active' : visibility === 'staging' ? 'archived' : undefined,
    expiration_date: text(r.expiration_date) === null ? null : metaDayOk(String(r.expiration_date).slice(0, 10)) ? String(r.expiration_date).slice(0, 10) : undefined,
    shipping_weight: weight === null && unit === null ? null : weight !== null && unit ? `${weight} ${unit}` : undefined,
    origin_country: text(r.origin_country), importer_name: text(r.importer_name),
    importer_address: address ? Object.fromEntries(Object.entries(address).filter(([k, v]) => ['street1', 'street2', 'city', 'region', 'postal_code', 'country'].includes(k) && typeof v === 'string')) : null,
    google_product_category: undefined, shipping: undefined, video: undefined, user_rating: undefined, rating_count: undefined,
  }
  for (const n of [0, 1, 2, 3, 4]) {
    out[`custom_label_${n}`] = text(r[`custom_label_${n}`])
    out[`custom_number_${n}`] = r[`custom_number_${n}`] === undefined || r[`custom_number_${n}`] === null ? null : Number.isSafeInteger(num(r[`custom_number_${n}`])) ? num(r[`custom_number_${n}`]) : undefined
  }
  return out
}

export interface ItemNow { itemId: string | null; sku: string; state: Record<string, unknown>; currency: string | null; name: string | null }

/**
 * The items of a catalog among these retailer ids, with their write state (50 ids a read, the products edge's filter as
 * step 12 builds it). `d7`: only the D7 columns (a labels upload). Missing = not an item of the catalog now.
 */
export async function liveItemsNow(account: MetaChosenAccount, catalogId: string, skus: readonly string[], d7 = false): Promise<Map<string, ItemNow>> {
  const found = new Map<string, ItemNow>()
  for (let i = 0; i < skus.length; i += 50) {
    const part = [...new Set(skus.slice(i, i + 50))]
    const read = await listPaged(account.connectionId, d7 ? 'catalogItems.labelsNow' : 'catalogItems.itemsNow', `${catalogId}/products`, { filter: { retailer_id: { is_any: part } }, fields: d7 ? META_ITEM_D7_FIELDS : META_ITEM_STATE_FIELDS }, 100)
    for (const r of read.rows) {
      const sku = text(r.retailer_id)
      if (!sku || !part.includes(sku)) continue
      found.set(sku, { itemId: metaObjectId(r.id), sku, state: writeStateOf(r), currency: text(r.currency), name: text(r.name) })
    }
  }
  return found
}

/** An item's overrides of one type (step 12's override_details read, SDK only): each override value → its fields. */
export async function liveItemOverrides(account: MetaChosenAccount, itemId: string, type: MetaOverrideType): Promise<Map<string, Record<string, unknown>>> {
  const read = await listPaged(account.connectionId, 'catalogItems.overrides', `${itemId}/override_details`, { fields: 'key,type,values', type }, 100)
  const out = new Map<string, Record<string, unknown>>()
  for (const r of read.rows) {
    const key = text(r.key)
    if (key && (!text(r.type) || String(r.type).toUpperCase() === type)) out.set(key, obj(r.values) ?? {})
  }
  return out
}

/** An item group (its catalog checked by step 12's catalogChild kind group) and its items' ids. */
export async function liveGroup(account: MetaChosenAccount, groupId: string, catalogId?: string | null): Promise<{ groupId: string; catalogId: string; groupSku: string | null; itemIds: Set<string>; more: boolean }> {
  const { id, catalog } = await catalogChild(account, { kind: 'group', id: groupId, catalogId })
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'catalogItems.group', path: id, query: { fields: 'id,retailer_id' } })
  const items = await listPaged(account.connectionId, 'catalogItems.groupItems', `${id}/products`, { fields: 'id' }, 500)
  return { groupId: id, catalogId: catalog.catalogId, groupSku: text((read.body as Row).retailer_id), itemIds: new Set(items.rows.map((r) => metaObjectId(r.id)).filter((x): x is string => !!x)), more: items.more }
}

// ── feeds ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const SCHEDULE_FIELDS = 'interval,interval_count,hour,minute,day_of_week,day_of_month,timezone,url'
export const FEED_STATE_FIELDS = `id,name,ingestion_source_type,override_type,deletion_enabled,default_currency,delimiter,encoding,quoted_fields_mode,product_count,schedule{${SCHEDULE_FIELDS}},update_schedule{${SCHEDULE_FIELDS}}`

export interface FeedSchedule { interval: string | null; url: string | null; interval_count?: number; hour?: number; minute?: number; day_of_week?: string; day_of_month?: number; timezone?: string }
export interface FeedNow {
  feedId: string
  name: string | null
  supplementary: boolean | null
  overrideType: string | null
  deletionEnabled: boolean | null
  defaultCurrency: string | null
  delimiter: string | null
  encoding: string | null
  quotedFieldsMode: string | null
  productCount: number | null
  schedule: FeedSchedule | null
  updateSchedule: FeedSchedule | null
}

function scheduleNow(v: unknown): FeedSchedule | null {
  const s = obj(v)
  if (!s || (!text(s.url) && !text(s.interval))) return null
  const out: FeedSchedule = { interval: text(s.interval)?.toUpperCase() ?? null, url: text(s.url) }
  if (num(s.interval_count) !== null) out.interval_count = num(s.interval_count)!
  if (num(s.hour) !== null) out.hour = num(s.hour)!
  if (num(s.minute) !== null) out.minute = num(s.minute)!
  if (text(s.day_of_week)) out.day_of_week = String(s.day_of_week).toUpperCase()
  if (num(s.day_of_month) !== null) out.day_of_month = num(s.day_of_month)!
  if (text(s.timezone)) out.timezone = String(s.timezone)
  return out
}

export function feedNowOf(r: Row): FeedNow {
  const type = text(r.ingestion_source_type)
  return {
    feedId: metaObjectId(r.id) ?? '', name: text(r.name), supplementary: type ? /supplementary/i.test(type) : null, overrideType: text(r.override_type)?.toUpperCase() ?? null,
    deletionEnabled: typeof r.deletion_enabled === 'boolean' ? r.deletion_enabled : null, defaultCurrency: text(r.default_currency), delimiter: text(r.delimiter),
    encoding: text(r.encoding), quotedFieldsMode: text(r.quoted_fields_mode), productCount: num(r.product_count), schedule: scheduleNow(r.schedule), updateSchedule: scheduleNow(r.update_schedule),
  }
}

/** One feed of a catalog (step 12's catalogChild kind feed first: in the catalog's own feeds), with what a change compares. */
export async function liveFeedNow(account: MetaChosenAccount, catalogId: string, feedId: string): Promise<FeedNow> {
  const { id } = await catalogChild(account, { kind: 'feed', id: feedId, catalogId })
  return feedNowOf((await metaReadOne({ connectionId: account.connectionId }, { operation: 'catalogFeeds.feed', path: id, query: { fields: FEED_STATE_FIELDS } })).body as Row)
}

/** The catalog's primary data sources (supplementary-feeds.md: a supplementary feed attaches to these), by id. */
export async function livePrimarySources(account: MetaChosenAccount, catalogId: string): Promise<{ ids: Set<string>; more: boolean }> {
  const read = await listPaged(account.connectionId, 'catalogFeeds.primarySources', `${catalogId}/data_sources`, { ingestion_source_type: 'PRIMARY', fields: 'id' }, 100)
  return { ids: new Set(read.rows.map((r) => metaObjectId(r.id)).filter((x): x is string => !!x)), more: read.more }
}

export interface FeedRuleNow { ruleId: string; attribute: string | null; ruleType: string | null; params: Record<string, unknown> | null }
/** A feed's rules (product-feed/rules Reading). */
export async function liveFeedRules(account: MetaChosenAccount, feedId: string): Promise<{ rules: FeedRuleNow[]; more: boolean }> {
  const read = await listPaged(account.connectionId, 'catalogFeeds.rules', `${feedId}/rules`, { fields: 'id,attribute,rule_type,params' }, 100)
  const rules = read.rows.map((r) => ({ ruleId: metaObjectId(r.id) ?? '', attribute: text(r.attribute), ruleType: text(r.rule_type), params: obj(r.params) ?? parsedParams(r.params) })).filter((r) => !!r.ruleId)
  return { rules, more: read.more }
}
function parsedParams(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string') return null
  try { return obj(JSON.parse(v)) } catch { return null }
}

/** Is this upload one of the feed's newest 500 (step 12's catalogChild kind upload)? */
export async function liveFeedUpload(account: MetaChosenAccount, catalogId: string, feedId: string, uploadId: string): Promise<{ uploadId: string; catalogId: string }> {
  const { id, catalog } = await catalogChild(account, { kind: 'upload', id: uploadId, catalogId, feedId })
  return { uploadId: id, catalogId: catalog.catalogId }
}

/** The step 12 D7 columns (re-exported: the tools and drafts build their files from these). */
export { D7_KEY_COLUMN, D7_NEXUS_COLUMNS }

/** What a labels upload reads of the items it names: their D7 columns now, by retailer id. */
export async function liveLabelsNow(account: MetaChosenAccount, catalogId: string, skus: readonly string[]): Promise<Map<string, ItemNow>> {
  return liveItemsNow(account, catalogId, skus, true)
}
