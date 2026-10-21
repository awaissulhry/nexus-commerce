/**
 * Meta ads step 34 (2026-10-21) — what the catalog changes read LIVE before they are drafted (GET only, through the gateway):
 * a catalog's settings, categories, connected pixels and apps, people, partners, product sets, the campaigns, ad sets and
 * ads of the chosen ad account that show it or one of its sets, a set, items by retailer id, an item, a feed. Every read here runs AFTER the
 * tool's writableCatalog (catalog-rule.ts, step 12) allowed the catalog — the drafts call that rule first, at the preview
 * and again when the approved change runs (the builder runs twice). Reuses step 12's and step 13's readers; reads nothing
 * of another business (a partner portfolio another Nexus business uses is its id and the flag only).
 *
 * Checked 2026-10-21: product-catalog fields (name, default_image_url, fallback_image_url — a list on read —,
 * da_display_settings, product_count, is_catalog_segment), product-catalog/categories (categorization_criteria required;
 * the top 1,000 by product count: advantage-catalog-ads/get-started.md), external_event_sources, assigned_users
 * (`business` required; `tasks` are "all unpacked roles/tasks"), agencies (SDK), product_sets, product-set node (filter,
 * retailer_id, product_count, latest_metadata), ad-campaign (ad set) `promoted_object` {product_catalog_id,
 * product_set_id}, business/business_users and system_users.
 */
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { listPaged, part } from './paging.js'
import { catalogChild, D7_SHOPIFY, nameOrHost, writableCatalog, type CatalogWritePurpose, type ReadableCatalog, type CatalogWriter } from './catalog-rule.js'
import { liveCatalogItems } from './live-catalog.js'
import { takenIds } from './taken.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : typeof v === 'string' && v.trim() ? [v] : [])

/** D7's plain answer when Shopify writes the catalog's items (the notes' sentence, then step 12's). */
export const SHOPIFY_OWNS_ITEMS = 'Shopify owns these items: remove them in Shopify.'

/**
 * THE write check of every catalog change here: step 12's writableCatalog, its refusal in words; an items refusal on a
 * Shopify catalog starts with SHOPIFY_OWNS_ITEMS.
 */
export async function writableFor(account: MetaChosenAccount, catalogId: string, purpose: CatalogWritePurpose): Promise<{ catalog: ReadableCatalog; writer: CatalogWriter }> {
  try {
    const { catalog, writer } = await writableCatalog(account, catalogId, purpose)
    return { catalog, writer }
  } catch (err) {
    if (err instanceof MetaLiveRefusal && purpose === 'items' && err.message.includes(D7_SHOPIFY)) throw new MetaLiveRefusal(`${SHOPIFY_OWNS_ITEMS} ${err.message}`)
    if (err instanceof MetaReadError) throw new MetaLiveRefusal(`Nexus could not check that this catalog is the business's (${err.message}), so it changes nothing.`)
    throw err
  }
}

const read = async (account: MetaChosenAccount, operation: string, path: string, fields: string) =>
  (await metaReadOne({ connectionId: account.connectionId }, { operation, path, query: { fields } })).body as Row

// ── a catalog's settings, categories, event sources ────────────────────────────────────────────────────────────────

export interface CatalogSettingsNow {
  catalogId: string
  name: string | null
  defaultImageUrl: string | null
  fallbackImageUrls: string[]
  displaySettings: { carouselAd: string | null; singleAd: string | null } | null
  productCount: number | null
}
export const CATALOG_SETTINGS_FIELDS = 'id,name,default_image_url,fallback_image_url,da_display_settings,product_count'

export function catalogSettingsOf(catalogId: string, b: Row): CatalogSettingsNow {
  const display = obj(b.da_display_settings)
  const transformation = (key: string) => text(obj(display?.[key])?.transformation_type)
  return {
    catalogId, name: text(b.name), defaultImageUrl: text(b.default_image_url), fallbackImageUrls: strings(b.fallback_image_url),
    displaySettings: display ? { carouselAd: transformation('carousel_ad'), singleAd: transformation('single_ad') } : null,
    productCount: num(b.product_count),
  }
}

export async function liveCatalogSettings(account: MetaChosenAccount, catalogId: string): Promise<CatalogSettingsNow> {
  return catalogSettingsOf(catalogId, await read(account, 'catalogAdmin.settings', catalogId, CATALOG_SETTINGS_FIELDS))
}

export interface CategoryNow { criteria: string; value: string; name: string | null; description: string | null; destinationUri: string | null; imageUrl: string | null }

/** The catalog's categories of one criteria (Meta answers the top 1,000 by product count), by value. */
export async function liveCatalogCategories(account: MetaChosenAccount, catalogId: string, criteria: string): Promise<{ byValue: Map<string, CategoryNow>; more: boolean }> {
  const list = await listPaged(account.connectionId, 'catalogAdmin.categories', `${catalogId}/categories`, { categorization_criteria: criteria, fields: 'criteria_value,name,description,destination_uri,image_url' }, 500)
  const byValue = new Map<string, CategoryNow>()
  for (const r of list.rows) {
    const value = text(r.criteria_value)
    if (value) byValue.set(value, { criteria, value, name: text(r.name), description: text(r.description), destinationUri: text(r.destination_uri), imageUrl: text(r.image_url) })
  }
  return { byValue, more: list.more }
}

export interface EventSourceNow { id: string; name: string | null; sourceType: string | null }
export async function liveEventSources(account: MetaChosenAccount, catalogId: string): Promise<{ sources: Map<string, EventSourceNow>; more: boolean }> {
  const list = await listPaged(account.connectionId, 'catalogAdmin.eventSources', `${catalogId}/external_event_sources`, { fields: 'id,name,source_type' }, 200)
  const sources = new Map<string, EventSourceNow>()
  for (const r of list.rows) { const id = metaObjectId(r.id); if (id) sources.set(id, { id, name: text(r.name), sourceType: text(r.source_type) }) }
  return { sources, more: list.more }
}

/** The chosen ad account's own pixels (Meta: pixels belong to the ad account, act_<id>/adspixels). */
export async function liveAccountPixels(account: MetaChosenAccount): Promise<{ pixels: Map<string, string | null>; more: boolean }> {
  const list = await listPaged(account.connectionId, 'catalogAdmin.pixels', `act_${account.adAccountId}/adspixels`, { fields: 'id,name' }, 200)
  const pixels = new Map<string, string | null>()
  for (const r of list.rows) { const id = metaObjectId(r.id); if (id) pixels.set(id, text(r.name)) }
  return { pixels, more: list.more }
}

// ── people and partners ───────────────────────────────────────────────────────────────────────────────────────────

export interface CatalogPersonNow { id: string; name: string | null; userType: string | null; tasks: string[] }
export async function liveCatalogPeople(account: MetaChosenAccount, catalogId: string, portfolioId: string): Promise<{ people: Map<string, CatalogPersonNow>; more: boolean }> {
  const list = await listPaged(account.connectionId, 'catalogAdmin.people', `${catalogId}/assigned_users`, { business: portfolioId, fields: 'id,name,user_type,tasks' }, 500)
  const people = new Map<string, CatalogPersonNow>()
  for (const r of list.rows) {
    const id = metaObjectId(r.id)
    if (id) people.set(id, { id, name: text(r.name), userType: text(r.user_type), tasks: strings(r.tasks).sort() })
  }
  return { people, more: list.more }
}

/** The business users and system users of the chosen portfolio (who may be given access to its catalogs). */
export async function livePortfolioPeople(account: MetaChosenAccount, portfolioId: string): Promise<{ people: Map<string, { name: string | null; kind: 'person' | 'system user' }>; more: boolean }> {
  const people = new Map<string, { name: string | null; kind: 'person' | 'system user' }>()
  let more = false
  for (const [edge, kind] of [['business_users', 'person'], ['system_users', 'system user']] as const) {
    const list = await listPaged(account.connectionId, `catalogAdmin.${edge}`, `${portfolioId}/${edge}`, { fields: 'id,name' }, 500)
    for (const r of list.rows) { const id = metaObjectId(r.id); if (id) people.set(id, { name: text(r.name), kind }) }
    more = more || list.more
  }
  return { people, more }
}

/** The partner portfolios the catalog is shared with; one another Nexus business uses is its id and the flag only. */
export async function liveCatalogAgencies(account: MetaChosenAccount, catalogId: string): Promise<{ agencies: Map<string, { name: string | null; takenByAnotherBusiness: boolean }>; more: boolean }> {
  const list = await listPaged(account.connectionId, 'catalogAdmin.agencies', `${catalogId}/agencies`, { fields: 'id,name' }, 500)
  const ids = list.rows.map((r) => metaObjectId(r.id)).filter((id): id is string => !!id)
  const taken = await takenIds('PORTFOLIO', ids)
  const agencies = new Map<string, { name: string | null; takenByAnotherBusiness: boolean }>()
  for (const r of list.rows) {
    const id = metaObjectId(r.id)
    if (id) agencies.set(id, taken.has(id) ? { name: null, takenByAnotherBusiness: true } : { name: text(r.name), takenByAnotherBusiness: false })
  }
  return { agencies, more: list.more }
}

// ── product sets, and the campaigns, ad sets and ads that use a catalog ────────────────────────────────────────────────────────────

export interface SetRowNow { id: string; name: string | null; productCount: number | null }
export async function liveCatalogSets(account: MetaChosenAccount, catalogId: string): Promise<{ sets: SetRowNow[]; more: boolean }> {
  const list = await listPaged(account.connectionId, 'catalogAdmin.sets', `${catalogId}/product_sets`, { fields: 'id,name,product_count' }, 500)
  return { sets: list.rows.map((r) => ({ id: metaObjectId(r.id) ?? '', name: text(r.name), productCount: num(r.product_count) })).filter((s) => !!s.id), more: list.more }
}

/** A campaign, ad set or ad of the chosen ad account that shows this catalog or one of these sets. */
export interface CatalogUser { kind: 'campaign' | 'adset' | 'ad'; id: string; name: string | null; effectiveStatus: string | null; uses: string }
/**
 * Who uses a catalog or set, as far as Nexus can see: `users`, and in words what it could NOT read (`unseen`: a list cut at
 * its first 500 rows, a list Meta refused, a catalog with more sets than Nexus read). Unseen counts as unknown: a change that
 * could widen delivery then says SPENDS MONEY (review B1 / A5).
 */
export interface CatalogUse { users: CatalogUser[]; unseen: string[] }

const USE_ROWS = 500
const USE_WORDS = { campaign: 'campaigns', adset: 'ad sets', ad: 'ads' } as const

/** Review N1 — product audiences an ad set may use without naming the set: Nexus cannot trace them cheaply (said). */
export const AUDIENCES_UNSEEN = 'ad sets of the ad account delivering now use custom or dynamic audiences (targeting custom_audiences / dynamic_audience_ids): a product audience among them may be built on this catalog or set, and Nexus does not trace it'
/** Review N1 — two places an ad can name a set that Meta's SDK alone names, which Nexus does not read (a set delete says so). */
export const SDK_SET_FIELDS_UNSEEN = 'an ad may also name a set where only Meta\'s SDK documents it (creative_sourcing_spec.associated_product_set_id, object_story_spec.link_data.boosted_product_set_id): Nexus does not read those, so such ads are not listed'

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => metaObjectId(obj(x)?.id ?? x)).filter((id): id is string => !!id) : [])
const listOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((x): x is Row => !!obj(x)) : Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]).filter((x): x is Row => !!obj(x)) : [])

/** The sets an ad set or campaign names: its promoted object's product_set_id and boosted_product_set_id, its targeting's product audiences (included and excluded). */
function setsNamed(row: Row): string[] {
  const promoted = obj(row.promoted_object)
  const targeting = obj(row.targeting)
  const fromAudiences = [...listOf(targeting?.product_audience_specs), ...listOf(targeting?.excluded_product_audience_specs)].map((s) => metaObjectId(s.product_set_id))
  return [metaObjectId(promoted?.product_set_id), metaObjectId(promoted?.boosted_product_set_id), ...fromAudiences].filter((id): id is string => !!id)
}

/**
 * The chosen ad account's campaigns and ad sets whose promoted object names this catalog (`product_catalog_id`) or one of
 * these sets (`product_set_id`, `boosted_product_set_id`), its ad sets whose targeting names one in a product audience
 * (`product_audience_specs[].product_set_id`, `excluded_product_audience_specs[].product_set_id`), and its ads whose creative
 * names one (`creative{product_set_id}`: catalog ads often name their set only there). Checked 2026-10-21:
 * reference/ad-promoted-object.md (product_catalog_id, product_set_id, boosted_product_set_id), reference/ad-campaign
 * `targeting` and SDK targeting.py / targetingproductaudiencespec.py (product_audience_specs, excluded_product_audience_specs:
 * {product_set_id, inclusions, exclusions}; custom_audiences, dynamic_audience_ids), reference/
 * ad-creative `product_set_id`. Ad sets delivering now with custom or dynamic audiences add AUDIENCES_UNSEEN (a product
 * audience there is not traced; LIVE-PROBES CA34-09 may narrow it); a set's or a catalog's delete adds SDK_SET_FIELDS_UNSEEN. Other ad accounts are not seen (said).
 */
export async function liveCatalogUsers(account: MetaChosenAccount, input: { catalogId?: string | null; setIds?: readonly string[]; setsMore?: boolean; forSetDelete?: boolean }): Promise<CatalogUse> {
  const sets = new Set(input.setIds ?? [])
  const users: CatalogUser[] = []
  const unseen: string[] = []
  if (input.setsMore) unseen.push('the catalog has more product sets than Nexus read (500): ads on the others were not checked')
  const reads: Array<{ kind: CatalogUser['kind']; path: string; fields: string }> = [
    { kind: 'campaign', path: `act_${account.adAccountId}/campaigns`, fields: 'id,name,effective_status,promoted_object' },
    { kind: 'adset', path: `act_${account.adAccountId}/adsets`, fields: 'id,name,effective_status,promoted_object,targeting' },
    { kind: 'ad', path: `act_${account.adAccountId}/ads`, fields: 'id,name,adset_id,effective_status,creative{product_set_id}' },
  ]
  let audiences = false
  for (const r of reads) {
    const read = await part(() => listPaged(account.connectionId, `catalogAdmin.${r.kind}sUsing`, r.path, { fields: r.fields }, USE_ROWS))
    if (read.notRead) { unseen.push(`the ad account's ${USE_WORDS[r.kind]} (${read.notRead})`); continue }
    if (read.value?.more) unseen.push(`more than ${USE_ROWS} ${USE_WORDS[r.kind]} of the ad account (Nexus read the first ${USE_ROWS})`)
    for (const row of read.value?.rows ?? []) {
      const id = metaObjectId(row.id)
      if (!id) continue
      // Only an ad set delivering now (the same rule as the drafts' delivering check): one that switches on after approval
      // turns `unseen` on, so the spend premise in stands moves and the run is refused.
      if (r.kind === 'adset' && text(row.effective_status) === 'ACTIVE') {
        const targeting = obj(row.targeting)
        if (idsOf(targeting?.custom_audiences).length || idsOf(targeting?.dynamic_audience_ids).length) audiences = true
      }
      const named = r.kind === 'ad' ? [metaObjectId(obj(row.creative)?.product_set_id)].filter((x): x is string => !!x) : setsNamed(row)
      const set = named.find((s) => sets.has(s))
      const catalog = r.kind === 'ad' ? null : metaObjectId(obj(row.promoted_object)?.product_catalog_id)
      const base = { kind: r.kind, id, name: text(row.name), effectiveStatus: text(row.effective_status) }
      if (set) users.push({ ...base, uses: `product set ${set}` })
      else if (input.catalogId && catalog === input.catalogId) users.push({ ...base, uses: `catalog ${catalog}` })
    }
  }
  if (audiences) unseen.push(AUDIENCES_UNSEEN)
  if (input.forSetDelete) unseen.push(SDK_SET_FIELDS_UNSEEN)
  return { users, unseen }
}

/** The Meta id of Nexus's own system user: the connection's stored one, else `me` read now (null when neither answers). */
export async function liveNexusSystemUser(account: MetaChosenAccount): Promise<string | null> {
  const stored = metaObjectId(account.connection.systemUser?.id)
  if (stored) return stored
  try {
    return metaObjectId((await read(account, 'catalogAdmin.me', 'me', 'id')).id)
  } catch (err) {
    if (err instanceof MetaReadError) return null
    throw err
  }
}

export interface SetNow {
  productSetId: string
  catalogId: string
  name: string | null
  /** The filter as Meta answers it (a JSON string; '' = every item). */
  filter: string
  retailerId: string | null
  productCount: number | null
  metadata: { coverImageUrl: string | null; description: string | null; externalUrl: string | null; externalUrlHandle: string | null } | null
}
export const SET_READ_FIELDS = 'id,name,filter,retailer_id,product_count,latest_metadata,product_catalog{id}'

export function setOf(id: string, catalogId: string, b: Row): SetNow {
  const meta = obj(b.latest_metadata)
  const filter = typeof b.filter === 'string' ? b.filter : b.filter && typeof b.filter === 'object' ? JSON.stringify(b.filter) : ''
  return {
    productSetId: id, catalogId, name: text(b.name), filter, retailerId: text(b.retailer_id), productCount: num(b.product_count),
    metadata: meta ? { coverImageUrl: text(meta.cover_image_url), description: text(meta.description), externalUrl: text(meta.external_url), externalUrlHandle: text(meta.external_url_handle) } : null,
  }
}

/** A product set by its id, checked first by step 12's catalogChild (its own product_catalog, a readable catalog). */
export async function liveSet(account: MetaChosenAccount, productSetId: string, catalogId?: string | null): Promise<SetNow> {
  const { id, catalog } = await catalogChild(account, { kind: 'product_set', id: productSetId, catalogId })
  return setOf(id, catalog.catalogId, await read(account, 'catalogAdmin.set', id, SET_READ_FIELDS))
}

// ── items and feeds ───────────────────────────────────────────────────────────────────────────────────────────────

/** The items of a catalog among these retailer ids (SKUs), read through step 12's item list, 50 ids a read. */
export async function liveItemsBySku(account: MetaChosenAccount, catalogId: string, skus: readonly string[]): Promise<Map<string, { itemId: string | null; name: string | null }>> {
  const found = new Map<string, { itemId: string | null; name: string | null }>()
  for (let i = 0; i < skus.length; i += 50) {
    const part = skus.slice(i, i + 50)
    const list = await liveCatalogItems({ connectionId: account.connectionId, view: 'list', catalogId, skus: [...part], maxRows: 100 })
    for (const item of (list as { items?: Array<{ itemId: string | null; sku: string | null; name: string | null }> }).items ?? []) {
      if (item.sku && part.includes(item.sku)) found.set(item.sku, { itemId: item.itemId, name: item.name })
    }
  }
  return found
}

/** One item by its Meta id, checked first by step 12's catalogChild (its own product_catalog). */
export async function liveItem(account: MetaChosenAccount, itemId: string, catalogId?: string | null): Promise<{ itemId: string; catalogId: string; sku: string | null; name: string | null }> {
  const { id, catalog } = await catalogChild(account, { kind: 'item', id: itemId, catalogId })
  const b = await read(account, 'catalogAdmin.item', id, 'id,retailer_id,name')
  return { itemId: id, catalogId: catalog.catalogId, sku: text(b.retailer_id), name: text(b.name) }
}

/** One feed of a catalog, checked first by step 12's catalogChild (in the catalog's own feeds). */
export async function liveFeed(account: MetaChosenAccount, catalogId: string, feedId: string): Promise<{ feedId: string; name: string | null; supplementary: boolean | null; productCount: number | null }> {
  const { id } = await catalogChild(account, { kind: 'feed', id: feedId, catalogId })
  const b = await read(account, 'catalogAdmin.feed', id, 'id,name,ingestion_source_type,product_count')
  const type = text(b.ingestion_source_type)
  return { feedId: id, name: nameOrHost(b.name), supplementary: type ? /supplementary/i.test(type) : null, productCount: num(b.product_count) }
}
