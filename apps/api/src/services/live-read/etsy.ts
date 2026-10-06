/**
 * E1 — read live: one Etsy listing as Etsy holds it now, for the publish review (`readEtsyLive`) and the sheet's read
 * live (`readEtsyServerLive`). Read only, every call through the channel gateway (`etsyReader`) as the listing's own
 * account; the shop id comes from that account's identity, never from a caller.
 *
 * Four reads, in two steps: the listing with its translations and the shop first; only when the listing is not another
 * shop's (for the studio: only when Etsy names this shop), its inventory and its listing properties. Never `includes=Inventory` — Etsy answers 400 since 2026-07-29. The
 * comma form `includes=Images,Translations` is believed, not measured: when Etsy refuses it (400) the listing is read
 * once more without includes, and its translations are "not read" (null), never "none". Any other failure throws; the
 * studio turns it into its `liveReadError`.
 *
 * The normalised listing is deterministic: the same Etsy state gives the same JSON and the same revision. Timestamps,
 * views, favourites and the raw documents are left out, and stock and prices stay out of the revision (they move by
 * themselves and go through their own doors). Etsy sends its text HTML-escaped (`&quot;`, `&#39;`, `&amp;`), so text is
 * decoded once: a value equal to Nexus's never reads as different.
 *
 * Side-effect free at import (the studio and the live-read index load it): no studio module, no queue, no database.
 */
import { createHash } from 'node:crypto'
import { markLiveVariants, type LiveReadDestination, type LiveReadError, type LiveValue, type LiveVariations } from '@nexus/shared/live-read'
import { EtsyReadError, etsyReader } from '../etsy/read-client.js'
import { toInventoryWrite, type EtsyReadInventory, type EtsyWriteOffering } from '../etsy/inventory.js'
import { ETSY_LISTING_FIELDS, type EtsyInventoryStructure, type EtsyListingValues, type EtsyLiveListing, type EtsyLiveReader,
  type EtsyPropertyValue, type EtsyShopRead, type EtsyTranslation } from '../pim/studio-publication-etsy-types.js'
import type { ServerLiveRead } from './types.js'

type Json = Record<string, any>
/** The four answers as Etsy gave them (server side only). `translationsRead` is false when the plain read was used. */
export interface EtsyLiveRaw { listing: Json; inventory: Json; properties: Json; shop: Json; translationsRead: boolean }
/**
 * What the sheet's read keeps server side: whether the listing is this account's shop's (null: Etsy did not say), Etsy's
 * listing state (only `active` is live), and the documents — none of another shop's listing.
 */
export interface EtsyServerRaw { ownShop: boolean | null; state: string | null; documents: EtsyLiveRaw | null }
export interface EtsyListingReads {
  /** GET /listings/{id}?includes=Images,Translations */
  listing(listingId: string): Promise<unknown>
  /** GET /listings/{id} — only after Etsy refused the includes form (400). */
  listingPlain(listingId: string): Promise<unknown>
  inventory(listingId: string): Promise<unknown>
  /** GET /shops/{shop_id}/listings/{id}/properties */
  properties(listingId: string): Promise<unknown>
  shop(): Promise<unknown>
}
/**
 * E3 — the shop-wide reads of a create (kept out of `EtsyListingReads`, whose shape other readers implement): the shop,
 * one page of its drafts, and a batch of listing inventories. `etsyListingReads` gives both sets.
 */
export interface EtsyShopReads {
  /** GET /shops/{shop_id} */
  shop(): Promise<unknown>
  /** GET /shops/{shop_id}/listings?state=draft&limit=100&offset=<offset> (getListingsByShop) — this shop's drafts only. */
  drafts(offset: number): Promise<unknown>
  /** GET /listings/batch/inventory?listing_ids=<ids> (getListingsInventoryByListingIds, at most 100 ids). */
  inventories(listingIds: string[]): Promise<unknown>
}
export type EtsyLiveDestination = LiveReadDestination & { listingId: string }

export const ETSY_OTHER_SHOP = 'This Etsy listing belongs to another shop, not this account\'s, so Nexus reads nothing more of it and uses none of it.'
export const ETSY_SHOP_NOT_SAID = 'Etsy did not say which shop holds this listing, so Nexus does not compare it.'
/** Listing ids never cross businesses: another shop's listing is found by its id, then not read further, compared or shown. */
export class EtsyOtherShop extends Error {
  constructor() { super(ETSY_OTHER_SHOP); this.name = 'EtsyOtherShop' }
}

const PRODUCTION_PARTNERS_UNREAD = 'Etsy does not report production partners when Nexus reads a listing.'
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }
/** One pass, so `&amp;quot;` stays the text `&quot;`; an entity that names no character is left as written. */
const decodeEntities = (s: string) => s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (entity, name: string) => {
  if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? entity
  const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity
})
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
/** A code or id Etsy sends as text (state, language, units): trimmed, '' → null. */
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null
/** Words a person wrote (title, description, tags, materials, styles, property names and values): decoded, then as `text`. */
const words = (v: unknown): string | null => typeof v === 'string' ? text(decodeEntities(v)) : null
const wordList = (v: unknown): string[] => Array.isArray(v) ? v.map(words).filter((t): t is string => t !== null) : []
const codes = (v: unknown): string[] => Array.isArray(v) ? v.map(text).filter((t): t is string => t !== null) : []
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const flag = (v: unknown): boolean | null => typeof v === 'boolean' ? v : null
const numbers = (v: unknown): number[] => Array.isArray(v) ? v.map(num).filter((n): n is number => n !== null) : []
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** Code-point order, as `Array.prototype.sort` uses: the same in every locale. */
const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
/**
 * sha256 of the JSON with object keys sorted — the rule of the publish review's `publicationDigest`, kept here so this
 * reader loads no studio module at import. The revision is only ever compared with another revision from this file.
 */
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex')
/** Absent as the review's `etsyValue` says it: null, '', [] or an object whose members are all null. */
const value = (v: unknown): LiveValue => v == null || v === '' || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every(member => member == null)) ? { state: 'absent' } : { state: 'value', value: v }
const unread = (reason: string): LiveValue => ({ state: 'unread', reason })

/** A listing id, checked before it becomes a path (it comes from Nexus's own rows, where a bad id is stored, not stopped). */
function listingPath(listingId: string): string {
  if (!/^[1-9]\d*$/.test(listingId)) throw new Error('That is not an Etsy listing id; nothing was read.')
  return `/listings/${listingId}`
}

/** The reads of one account, each through the gateway (state, rate bucket, call ledger). The account is resolved once, on first use. */
export function etsyListingReads(accountId: string): EtsyListingReads & EtsyShopReads {
  let reader: ReturnType<typeof etsyReader> | null = null
  const get = async (path: (shopId: string) => string) => {
    const account = await (reader ??= etsyReader(accountId))
    return account.get<unknown>(path(account.shopId))
  }
  return {
    listing: listingId => get(() => `${listingPath(listingId)}?includes=Images,Translations`),
    listingPlain: listingId => get(() => listingPath(listingId)),
    inventory: listingId => get(() => `${listingPath(listingId)}/inventory`),
    properties: listingId => get(shopId => `/shops/${shopId}${listingPath(listingId)}/properties`),
    shop: () => get(shopId => `/shops/${shopId}`),
    drafts: offset => {
      if (!Number.isInteger(offset) || offset < 0) throw new Error('That is not a page of Etsy drafts; nothing was read.')
      return get(shopId => `/shops/${shopId}/listings?state=draft&limit=${DRAFT_PAGE}&offset=${offset}`)
    },
    inventories: listingIds => {
      if (!listingIds.length || listingIds.length > DRAFT_PAGE) throw new Error(`Etsy reads the inventories of 1 to ${DRAFT_PAGE} listings at once; nothing was read.`)
      for (const id of listingIds) listingPath(id)
      // Comma form, as Etsy's own examples for its batch reads (BELIEVED: the document names no array style).
      return get(() => `/listings/batch/inventory?listing_ids=${listingIds.join(',')}`)
    },
  }
}

/** True when the listing is this shop's, false when it is another shop's, null when Etsy did not say. */
const ownShopOf = (listing: Json, shop: Json): boolean | null =>
  listing.shop_id == null || shop.shop_id == null ? null : String(listing.shop_id) === String(shop.shop_id)

/**
 * `shopMustBeProven`: the studio compares what it reads and would send from it, so a listing Etsy names no shop for is
 * not taken to be this shop's (the identity check calls it "unverifiable"); the sheet's read still shows it.
 */
async function readEtsyRaw(listingId: string, reads: EtsyListingReads, shopMustBeProven = false): Promise<EtsyLiveRaw> {
  listingPath(listingId) // checked before any call, not after the account is resolved
  const listingRead = reads.listing(listingId).then(body => ({ body, translationsRead: true }), (error: unknown) => {
    if (error instanceof EtsyReadError && error.status === 400) return reads.listingPlain(listingId).then(body => ({ body, translationsRead: false }))
    throw error
  })
  const [read, shopBody] = await Promise.all([listingRead, reads.shop()])
  const listing = obj(read.body), shop = obj(shopBody)
  if (String(listing.listing_id ?? '') !== listingId) throw new Error('Etsy returned another or an unreadable listing.')
  const ownShop = ownShopOf(listing, shop)
  if (ownShop === false) throw new EtsyOtherShop()
  if (ownShop === null && shopMustBeProven) throw new Error(ETSY_SHOP_NOT_SAID)
  const [inventory, properties] = await Promise.all([reads.inventory(listingId), reads.properties(listingId)])
  return { listing, inventory: obj(inventory), properties: obj(properties), shop, translationsRead: read.translationsRead }
}

interface LiveProduct { sku: string; propertyValues: Json[]; offering: EtsyWriteOffering; currency: string | null; currencies: string[] }
const valuesOf = (product: LiveProduct, propertyId: number) => wordList(product.propertyValues.find(pv => num(pv.property_id) === propertyId)?.values)

/**
 * The live (not deleted) products in Etsy's order. The offering comes from `toInventoryWrite` — the same transform the
 * stock and price pushes send back — so a price is converted from Money once, in one place, and an inventory that
 * transform cannot take is a failed read here too, never a guess.
 */
function liveProducts(inventory: Json): LiveProduct[] {
  const read = inventory as EtsyReadInventory
  const write = toInventoryWrite(read)
  return (read.products ?? []).filter(product => product.is_deleted !== true).map((product, i) => {
    const currencies = (product.offerings ?? []).filter(offering => offering.is_deleted !== true)
      .map(offering => text(obj(offering.price).currency_code)?.toUpperCase() ?? null)
    const first = write.products[i].offerings[0]
    return { sku: text(product.sku) ?? '', propertyValues: (product.property_values ?? []).map(obj),
      offering: { price: first.price, quantity: first.quantity, is_enabled: first.is_enabled, readiness_state_id: first.readiness_state_id ?? null },
      currency: currencies[0] ?? null, currencies: currencies.filter((c): c is string => c !== null) }
  })
}

/** Etsy's answers in the review's one shape (§2). Pure: no clock, no I/O; throws when the inventory cannot be read. */
export function normaliseEtsyListing(listingId: string, raw: EtsyLiveRaw): EtsyLiveListing {
  const { listing, shop } = raw
  const weight = num(listing.item_weight)
  const [length, width, height] = [num(listing.item_length), num(listing.item_width), num(listing.item_height)]
  const values: EtsyListingValues = {
    title: words(listing.title), description: words(listing.description), tags: wordList(listing.tags), materials: wordList(listing.materials),
    taxonomy_id: num(listing.taxonomy_id),
    classification: { who_made: text(listing.who_made), when_made: text(listing.when_made), is_supply: flag(listing.is_supply) },
    // Etsy reads back `listing_type` and `style` for what it takes as `type` and `styles`.
    type: text(listing.listing_type), shop_section_id: num(listing.shop_section_id),
    shipping_profile_id: num(listing.shipping_profile_id), return_policy_id: num(listing.return_policy_id),
    item_weight: { value: weight, unit: weight === null ? null : text(listing.item_weight_unit) },
    item_dimensions: { length, width, height, unit: length === null && width === null && height === null ? null : text(listing.item_dimensions_unit) },
    is_taxable: flag(listing.is_taxable), should_auto_renew: flag(listing.should_auto_renew),
    production_partner_ids: [], styles: wordList(listing.style),
  }

  const products = liveProducts(raw.inventory)
  // Variation properties in the first product's order; one a later product adds (Etsy should not allow it) comes after.
  const axes: EtsyInventoryStructure['properties'] = []
  for (const pv of products.flatMap(product => product.propertyValues)) {
    const id = num(pv.property_id)
    if (id !== null && !axes.some(axis => axis.property_id === id)) axes.push({ property_id: id, property_name: words(pv.property_name) ?? '', scale_id: num(pv.scale_id) })
  }
  // Every live product, a SKU-less one included (sku ''): a full replace removes it, so the structure must show it.
  // E2 — and Etsy's sharing rule, the four `*_on_property` arrays (which properties price, stock, SKU and processing
  // profile vary by; empty = one for every variation, R1 §3), ids ascending, an absent array read as []. They are part of
  // the structure, so of the revision: a change of what the variations share is a change of the listing.
  const onProperty = (key: 'price_on_property' | 'quantity_on_property' | 'sku_on_property' | 'readiness_state_on_property') =>
    [...new Set(numbers(raw.inventory[key]))].sort((a, b) => a - b)
  const inventory: EtsyInventoryStructure = { properties: axes, products: products
    .map(product => ({ sku: product.sku, values: axes.map(({ property_id }) => ({ property_id, values: valuesOf(product, property_id) })),
      readiness_state_id: product.offering.readiness_state_id ?? null }))
    .sort((a, b) => byText(a.sku, b.sku) || byText(JSON.stringify(a.values), JSON.stringify(b.values))),
    price_on_property: onProperty('price_on_property'), quantity_on_property: onProperty('quantity_on_property'),
    sku_on_property: onProperty('sku_on_property'), readiness_state_on_property: onProperty('readiness_state_on_property') }
  const firstBySku = new Map<string, EtsyWriteOffering>()
  for (const product of products) if (product.sku && !firstBySku.has(product.sku)) firstBySku.set(product.sku, product.offering)

  const properties: EtsyPropertyValue[] = (Array.isArray(raw.properties.results) ? raw.properties.results as unknown[] : []).map(obj)
    .flatMap(p => { const id = num(p.property_id); return id === null ? [] : [{ property_id: id, property_name: words(p.property_name) ?? '',
      value_ids: numbers(p.value_ids), values: wordList(p.values), scale_id: num(p.scale_id) }] })
    .sort((a, b) => a.property_id - b.property_id)
  const translations: EtsyTranslation[] | null = raw.translationsRead && Array.isArray(listing.translations)
    ? (listing.translations as unknown[]).map(obj).flatMap(t => { const language = text(t.language); return language ? [{ language, title: words(t.title), description: words(t.description), tags: wordList(t.tags) }] : [] })
      .sort((a, b) => byText(a.language, b.language))
    : null
  const state = text(listing.state)
  return {
    listingId, state, language: text(listing.language), values,
    unread: { production_partner_ids: PRODUCTION_PARTNERS_UNREAD },
    properties, inventory,
    offerings: Object.fromEntries([...firstBySku].sort(([a], [b]) => byText(a, b))),
    unnamedProducts: products.filter(product => !product.sku).length,
    translations,
    shop: { languages: codes(shop.languages), currencyCode: text(shop.currency_code)?.toUpperCase() ?? null },
    priceCurrencies: [...new Set(products.flatMap(product => product.currencies))].sort(byText),
    // E2 — an active listing that sells its last unit turns `sold_out` (and back on a restock): a sale must not refuse a
    // send, so the revision reads the two as one. `inactive` (someone paused it) still changes it. `state` stays raw.
    revision: digest({ state: state === 'sold_out' ? 'active' : state, values, properties, inventory, translations }),
  }
}

/** The studio's reader: one normalised listing of this shop, or a throw with the reason (another shop's, or no shop named). */
export const readEtsyLive: EtsyLiveReader = async ({ accountId, listingId }) => normaliseEtsyListing(listingId, await readEtsyRaw(listingId, etsyListingReads(accountId), true))

/**
 * The sheet's read live, in the shared LiveRead shape. Content is keyed by the review's change fields (the 16 listing
 * fields, `property:<id>` for every non-variation property, `translation:<language>`, `inventory`); variations carry each
 * live product's values, price and available stock, marked against Nexus's SKUs. Etsy's listing state and whose shop
 * holds the listing stay server side in `raw` (`EtsyServerRaw`), for the identity check — as eBay's GetItem does.
 */
export async function readEtsyServerLive(destination: EtsyLiveDestination, reads: EtsyListingReads, now = () => new Date()): Promise<ServerLiveRead<EtsyServerRaw | null>> {
  const { expectedSkus, listingId, ...where } = destination
  let raw: EtsyLiveRaw, live: EtsyLiveListing
  try {
    raw = await readEtsyRaw(listingId, reads)
    live = normaliseEtsyListing(listingId, raw)
  } catch (error) {
    const reason = message(error)
    return { readAt: now().toISOString(), source: 'etsy-listing', destination: where, revision: null, variations: null, errors: [{ scope: 'item', reason }],
      content: Object.fromEntries(ETSY_LISTING_FIELDS.map(field => [field, unread(reason)])),
      raw: error instanceof EtsyOtherShop ? { ownShop: false, state: null, documents: null } : null }
  }
  const errors: LiveReadError[] = []
  const content: Record<string, LiveValue> = Object.fromEntries(ETSY_LISTING_FIELDS.map(field => [field, live.unread[field] ? unread(live.unread[field]!) : value(live.values[field])]))
  const axisIds = new Set(live.inventory.properties.map(axis => axis.property_id))
  for (const property of live.properties) if (!axisIds.has(property.property_id)) content[`property:${property.property_id}`] = value(property)
  if (live.translations === null) errors.push({ scope: 'field', field: 'translations', reason: 'Etsy did not return this listing\'s translations, so they were not read.' })
  for (const translation of live.translations ?? []) content[`translation:${translation.language}`] = value(translation)
  content.inventory = value(live.inventory)

  let variations: LiveVariations | null = null
  if (live.inventory.properties.length) {
    const axes = live.inventory.properties.map(axis => axis.property_name || `Property ${axis.property_id}`)
    const order: Record<string, string[]> = Object.fromEntries(axes.map(axis => [axis, []]))
    const variants = liveProducts(raw.inventory).map(product => {
      const values: Record<string, string> = {}
      live.inventory.properties.forEach(({ property_id }, i) => {
        const shown = valuesOf(product, property_id).join(', ')
        if (!shown) return
        values[axes[i]] = shown
        if (!order[axes[i]].includes(shown)) order[axes[i]].push(shown)
      })
      return { sku: product.sku, values, price: { state: 'value' as const, value: { amount: String(product.offering.price), currency: product.currency } },
        stock: { state: 'value' as const, value: product.offering.quantity } }
    })
    variations = { axes, variants: markLiveVariants(expectedSkus, variants), order }
  }
  return { readAt: now().toISOString(), source: 'etsy-listing', destination: where, revision: live.revision, content, variations, errors,
    raw: { ownShop: ownShopOf(raw.listing, raw.shop), state: live.state, documents: raw } }
}

// ── E3 — the shop read of a create review, and the draft search of a create's recovery ─────────────────────────────

/** getListingsByShop's largest page (R1 §14), and the batch inventory's cap (R1 §3). */
const DRAFT_PAGE = 100
/**
 * At most 5,000 drafts are searched (50 pages, one call each, about a minute's quota at worst): a shop with more cannot be
 * searched whole, and a partial "none" would be a lie, so it is refused by name.
 */
const DRAFT_PAGES = 50
/** A draft's creation time may come a little before Nexus's marker (clocks differ): 10 minutes of slack. */
const DRAFT_CLOCK_SLACK_MS = 10 * 60_000
/** A draft the search listed whose existence Etsy could not then confirm or deny: the search cannot answer "none". */
export class EtsyDraftUnconfirmed extends Error {
  constructor(listingId: string, reason: string) {
    super(`Nexus could not tell whether Etsy still holds draft ${listingId} (${reason}); check again later.`)
    this.name = 'EtsyDraftUnconfirmed'
  }
}
export const ETSY_TOO_MANY_DRAFTS = 'This shop has more than 5,000 Etsy drafts; Nexus cannot search them all. Delete drafts you do not need on Etsy, then try again.'

/** Etsy's listing id as text: a safe whole number or a digit string, else null (never a rounded 64-bit id, R1 §14). */
const listingIdOf = (v: unknown): string | null => typeof v === 'number' ? (Number.isSafeInteger(v) && v > 0 ? String(v) : null)
  : typeof v === 'string' && /^[1-9]\d*$/.test(v.trim()) ? v.trim() : null
/** A title as the search compares it: whitespace collapsed, case ignored. */
const titleKey = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * E3 — what a create review needs of the shop (GET /shops/{shop_id}, this account's own shop): its languages (the first is
 * the listing language) and its currency, by the same rules as the live read (codes trimmed, the currency upper-cased).
 */
export async function readEtsyShop(accountId: string, reads: Pick<EtsyShopReads, 'shop'> = etsyListingReads(accountId)): Promise<EtsyShopRead> {
  const shop = obj(await reads.shop())
  return { languages: codes(shop.languages), currencyCode: text(shop.currency_code)?.toUpperCase() ?? null }
}

/**
 * E3 — the drafts in THIS shop (the account's own; never another shop's) that a create whose answer was lost may have
 * made: the same title (whitespace collapsed, case ignored, Etsy's HTML escapes decoded), created no earlier than 10
 * minutes before the marker (when Etsy gives a creation time: `created_timestamp`, seconds, BELIEVED), and whose live
 * SKUs are all empty (Etsy's first product, before Nexus's inventory step) or all among the create's SKUs. Pages the
 * drafts (100 per page, at most 50 pages: more throws, a partial search is never "none"), then ONE batch inventory read
 * of the candidates (getListingsInventoryByListingIds; more than 100 candidates are read 100 at a time). Etsy answers the
 * whole batch 404 when one id no longer exists (R1 §3, §16): the batch is then split in halves until that id is alone,
 * and the id is proven with its own `GET /listings/{id}`: only a 404 there means Etsy no longer holds it (not a
 * candidate); a 200 means it exists (its own inventory GET then judges its SKUs); any other answer throws
 * `EtsyDraftUnconfirmed` (never "gone" on a guess: a real draft dropped here would let the next Publish make a second).
 * Any other failed read, or an answer that is not the shape Etsy documents, throws: the caller cannot tell then whether
 * a draft exists.
 */
export async function findEtsyDrafts(accountId: string, input: { title: string; since: string; skus: string[] },
  reads: Pick<EtsyShopReads, 'drafts' | 'inventories'> & Pick<EtsyListingReads, 'listingPlain' | 'inventory'> = etsyListingReads(accountId))
  : Promise<Array<{ listingId: string; title: string; createdAt: string | null }>> {
  const wanted = titleKey(typeof input.title === 'string' ? input.title : '')
  if (!wanted) throw new Error('The create left no title to look for.')
  const since = Date.parse(input.since)
  if (!Number.isFinite(since)) throw new Error('The create left no start time to look from.')
  const skus = new Set((input.skus ?? []).filter((sku): sku is string => typeof sku === 'string' && sku !== ''))

  const candidates: Array<{ listingId: string; title: string; createdAt: string | null }> = []
  for (let page = 0; ; page++) {
    if (page === DRAFT_PAGES) throw new Error(ETSY_TOO_MANY_DRAFTS)
    const answer = obj(await reads.drafts(page * DRAFT_PAGE))
    if (!Array.isArray(answer.results)) throw new Error('Etsy answered the list of drafts without its listings.')
    const results = (answer.results as unknown[]).map(obj)
    for (const listing of results) {
      const listingId = listingIdOf(listing.listing_id)
      const title = words(listing.title)
      const state = text(listing.state)
      if (!listingId || !title || (state !== null && state !== 'draft') || titleKey(title) !== wanted) continue
      const seconds = num(listing.created_timestamp) ?? num(listing.creation_timestamp) ?? num(listing.original_creation_timestamp)
      if (seconds !== null && seconds * 1000 < since - DRAFT_CLOCK_SLACK_MS) continue
      if (!candidates.some(candidate => candidate.listingId === listingId))
        candidates.push({ listingId, title, createdAt: seconds === null ? null : new Date(seconds * 1000).toISOString() })
    }
    const count = num(answer.count)
    if (results.length < DRAFT_PAGE || (count !== null && (page + 1) * DRAFT_PAGE >= count)) break
  }
  if (!candidates.length) return []

  /** One batch read; on Etsy's whole-batch 404, each half on its own, down to the one id the 404 is about (`confirmAlone`). */
  const gone = new Set<string>()
  /** The id a batch 404 is about, proven one way or the other: gone only on its own 404; present → its own inventory. */
  const confirmAlone = async (id: string): Promise<Json[]> => {
    try {
      await reads.listingPlain(id)
    } catch (error) {
      if (error instanceof EtsyReadError && error.status === 404) { gone.add(id); return [] }
      throw new EtsyDraftUnconfirmed(id, message(error))
    }
    let inventory: Json
    try { inventory = obj(await reads.inventory(id)) } catch (error) { throw new EtsyDraftUnconfirmed(id, message(error)) }
    return [{ listing_id: id, inventory }]
  }
  const readBatch = async (ids: string[]): Promise<Json[]> => {
    let answer: Json
    try {
      answer = obj(await reads.inventories(ids))
    } catch (error) {
      if (!(error instanceof EtsyReadError && error.status === 404)) throw error
      if (ids.length === 1) return confirmAlone(ids[0])
      const half = Math.ceil(ids.length / 2)
      return [...await readBatch(ids.slice(0, half)), ...await readBatch(ids.slice(half))]
    }
    if (!Array.isArray(answer.results)) throw new Error('Etsy answered the drafts\' inventories without its listings.')
    return (answer.results as unknown[]).map(obj)
  }
  const kept: typeof candidates = []
  for (let at = 0; at < candidates.length; at += DRAFT_PAGE) {
    const chunk = candidates.slice(at, at + DRAFT_PAGE)
    const results = await readBatch(chunk.map(candidate => candidate.listingId))
    for (const candidate of chunk) {
      if (gone.has(candidate.listingId)) continue
      const found = results.find(result => listingIdOf(result.listing_id) === candidate.listingId)
      const products = found ? obj(found.inventory).products : undefined
      if (!Array.isArray(products)) throw new Error(`Etsy did not return the inventory of draft ${candidate.listingId}.`)
      const live = (products as unknown[]).map(obj).filter(product => product.is_deleted !== true).map(product => text(product.sku) ?? '')
      if (live.every(sku => sku === '') || live.every(sku => skus.has(sku))) kept.push(candidate)
    }
  }
  return kept.sort((a, b) => byText(a.listingId, b.listingId))
}
