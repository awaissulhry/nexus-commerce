/**
 * Meta step 34 (2026-10-21) — the gateway's own checks of what a catalog change names (gateway.ts metaOwnerProblem and
 * metaBodyIdsProblem hand these kinds here, as step 28's meta-optimize-owner.ts). Nothing is sent to Meta unless it is this
 * business's: a catalog the tool's writableCatalog (marketing/meta-ads/catalog-rule.ts) allowed is checked AGAIN here with
 * the gateway's own reads, so a caller that skipped the tool still sends nothing to another business's catalog. Reads only,
 * through the gateway; a read that is refused, not a success, or cut (more pages than Nexus reads) refuses the change.
 *
 *   object a change names
 *     catalogbusiness  `<portfolio>/owned_product_catalogs` (a new catalog or segment): exactly the chosen ad account's
 *                      business portfolio, which no other Nexus business uses (nexus_meta_links_taken PORTFOLIO)
 *     catalog          `<catalog>…`: owned by that portfolio (`business`), shared (agencies, connected businesses) with no
 *                      portfolio another Nexus business uses; an items delete never on a segment (or where Meta does not
 *                      say); an items delete and a catalog's delete (not a segment's) only where step 12's writer check
 *                      lets Nexus write items (review A3: D7); a share with collaborative-ads terms or UTM settings only
 *                      of a segment (CT-134), and a segment's share with MANAGE / ADVERTISE only (review A6)
 *     productset       `<set>`: its own product_catalog (asked with `filter`, a field only a set has) is such a catalog
 *     productitem      `<item>`: its own product_catalog (with retailer_id and availability, an item's) is such a catalog,
 *                      not a segment, where the writer check lets Nexus write items
 *     productfeed      `<feed>` (DELETE): the change names the feed's catalog (metaParent), which is such a catalog; the
 *                      feed is in that catalog's own feeds and is a SUPPLEMENTARY feed (a primary feed's delete disables
 *                      every ad of its products: never sent by Nexus)
 *   ids inside a body
 *     catalogparent    a segment's parent: such a catalog, and no segment itself
 *     catalogpixel     a pixel connected: one of the chosen ad account's own pixels (act_<id>/adspixels)
 *     catalogsource    a pixel or app disconnected: connected to the catalog now (its external_event_sources)
 *     catalogperson    a person given access: a business user or system user of the chosen portfolio, never Nexus's own
 *                      system user (`me`)
 *     catalogassignee  a person removed: assigned to the catalog now, and never Nexus's own system user (`me`)
 *     catalogagency    a partner shared with: a portfolio no other Nexus business uses, never this business's own
 *     catalogpartner   a partner unshared: one the catalog is shared with now (its agencies)
 *     catalogshop      a shop a set is published to: a shop of the chosen Page's commerce accounts
 * Checked 2026-10-21: product-catalog `business`, `is_catalog_segment` (product-catalog.md fields), product-set and
 * product-item `product_catalog` (SDK productset.py, productitem.py), product-feed (no catalog field: SDK productfeed.py
 * Field), product-catalog/agencies + connected_businesses (step 12's catalogWriter reads the same), assigned_users
 * (`business` required), business/business_users and system_users, ad-account/adspixels, page/commerce_merchant_settings and
 * the commerce account's shops (step 13's commerce reads).
 */
import type { MetaJudgedWrite, MetaWriteBodyId } from './meta-calls.js'
import { chosenBusiness, listedIds, type MetaOwnerIo, type MetaOwnerProblem } from './meta-optimize-owner.js'
import { metaChosenPageOf } from './account.js'
import { takenIds } from '../marketing/meta-ads/taken.js'
import { isMetaCatalogItemsKind, type MetaCatalogKind } from './meta-catalog-rules.js'

const NOT_CHOSEN = 'META_ACCOUNT_NOT_CHOSEN'
const UNCONFIRMED = 'META_ACCOUNT_UNCONFIRMED'
const NOT_ALLOWED = 'META_WRITE_NOT_ALLOWED'
export const say = (code: string, sentence: string): MetaOwnerProblem => ({ code, sentence: `Nothing was sent to Meta: ${sentence}` })
const inside = (problem: MetaOwnerProblem): MetaOwnerProblem => ({ ...problem, sentence: problem.sentence.replace(/^Nothing was sent to Meta: /, 'Nothing was sent to Meta: inside this change, ') })
export const isProblem = (v: unknown): v is MetaOwnerProblem => !!v && typeof v === 'object' && 'code' in v && 'sentence' in v
const idOf = (v: unknown): string | null => {
  const raw = v && typeof v === 'object' ? (v as Record<string, unknown>).id : v
  return (typeof raw === 'string' || typeof raw === 'number') && /^\d{1,25}$/.test(String(raw)) ? String(raw) : null
}
/** How many pages of a list the checks read (100 ids a page). */
const PAGES = 5

/** The chosen ad account's portfolio, used by no other Nexus business — or why not. */
export async function portfolioOf(io: MetaOwnerIo): Promise<string | MetaOwnerProblem> {
  const chosen = await io.chosenAdAccount()
  if (!chosen) return say(NOT_CHOSEN, 'this business has no Meta ad account chosen through this connection, so Nexus changes no catalog.')
  const business = await chosenBusiness(io, chosen)
  if (!business) return say(UNCONFIRMED, 'Nexus could not read the business portfolio of the chosen ad account (a catalog belongs to a portfolio).')
  if ((await takenIds('PORTFOLIO', [business])).has(business)) {
    return say(NOT_CHOSEN, 'another business in Nexus uses an ad account of this Meta business portfolio, so Nexus cannot tell whose catalog is whose and changes none.')
  }
  return business
}

export interface CheckedCatalog { id: string; isSegment: boolean | null }

/** A catalog this business may change: the portfolio's own, shared with no portfolio another Nexus business uses. */
export async function writableHere(io: MetaOwnerIo, catalogId: string, business: string): Promise<CheckedCatalog | MetaOwnerProblem> {
  const body = await io.read(catalogId, { fields: 'id,business{id},is_catalog_segment' })
  if (!body || idOf(body) !== catalogId) return say(UNCONFIRMED, `Nexus could not read ${catalogId} as a Meta catalog (another kind of object, or not readable).`)
  if (idOf(body.business) !== business) return say(NOT_CHOSEN, `catalog ${catalogId} is not owned by the business portfolio of the ad account this business chose (a client catalog is another business's).`)
  const others: string[] = []
  for (const edge of ['agencies', 'connected_businesses']) {
    const ids = await listedIds(io, `${catalogId}/${edge}`, {}, PAGES)
    if (!ids) return say(UNCONFIRMED, `Nexus could not read who else has catalog ${catalogId} (${edge}), so it changes nothing in it.`)
    others.push(...[...ids].filter((id) => id !== business))
  }
  if ((await takenIds('PORTFOLIO', others)).size > 0) return say(NOT_CHOSEN, `catalog ${catalogId} is shared with a business portfolio another business in Nexus uses, so Nexus cannot tell whose change it would be.`)
  return { id: catalogId, isSegment: typeof body.is_catalog_segment === 'boolean' ? body.is_catalog_segment : null }
}

/** The catalog of a set or an item, by its own product_catalog (asked with fields only that kind has). */
async function catalogOfChild(io: MetaOwnerIo, id: string, fields: string, word: string): Promise<string | MetaOwnerProblem> {
  const body = await io.read(id, { fields })
  const catalogId = idOf(body?.product_catalog)
  if (!body || idOf(body) !== id || !catalogId) return say(UNCONFIRMED, `Nexus could not read ${id} as a ${word} of a Meta catalog.`)
  return catalogId
}

const ITEMS_RULES = new Set(['catalog.items.delete'])
const CATALOG_DELETES = new Set(['catalog.delete', 'catalog.delete.live'])
const formKeys = (body: string) => new Set(new URLSearchParams(body).keys())
const formOf = (body: string) => new URLSearchParams(body)

/**
 * Review A3 — D7 at the gateway too: an items delete, an item's delete and a catalog's delete (it takes its items) go only
 * where step 12's writer check (catalog-rule.ts writableCatalog, purpose 'items') lets Nexus write items — the same check the
 * tool ran, run again here with the gateway's own reads, so a caller that skipped the tool still deletes nothing Shopify or
 * another partner writes. Its refusal keeps step 12's words; a check that cannot be made sends nothing.
 */
async function itemsWriterProblem(connectionId: string, catalogId: string): Promise<MetaOwnerProblem | null> {
  const { metaChosenAccount, MetaLiveRefusal } = await import('../marketing/meta-ads/live.js')
  const { writableCatalog } = await import('../marketing/meta-ads/catalog-rule.js')
  try {
    await writableCatalog(await metaChosenAccount(connectionId), catalogId, 'items')
    return null
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return say(NOT_ALLOWED, `${/Shopify/.test(err.message) ? 'Shopify owns these items: remove them in Shopify. ' : ''}${err.message}`)
    return say(UNCONFIRMED, `Nexus could not check who writes catalog ${catalogId} (${err instanceof Error ? err.message : String(err)}), so it deletes nothing in it.`)
  }
}

/** Why a catalog change of this object is refused for this connection, or null. */
export async function metaCatalogOwnerProblem(
  connectionId: string, write: MetaJudgedWrite, kind: MetaCatalogKind, io: MetaOwnerIo, parent?: { kind: string; id: string },
): Promise<MetaOwnerProblem | null> {
  const id = write.objectId
  if (write.check) return say(NOT_ALLOWED, 'Meta documents no check (validate_only) for a catalog change.')
  // Step 35 — a catalog's items, an item group, a catalog's feeds, a feed, a feed's rule or upload: their own checks
  // (meta-catalog-items-owner.ts: the same portfolio and catalog checks, then step 35's D7 checks).
  if (isMetaCatalogItemsKind(kind)) return (await import('./meta-catalog-items-owner.js')).metaCatalogItemsOwnerProblem(connectionId, write, kind, io, parent)
  const business = await portfolioOf(io)
  if (isProblem(business)) return business
  switch (kind) {
    case 'catalogbusiness':
      return id === business ? null : say(NOT_CHOSEN, `${id} is not the business portfolio of the ad account this business chose: Nexus makes a catalog only there.`)
    case 'catalog': {
      const catalog = await writableHere(io, id, business)
      if (isProblem(catalog)) return catalog
      if (ITEMS_RULES.has(write.rule) && catalog.isSegment !== false) return say(NOT_ALLOWED, `catalog ${id} is a segment of another catalog (or Meta does not say whether it is one): its items live in the parent, so Nexus deletes no items here.`)
      // A catalog's delete takes its items: the writer check — a segment holds no items of its own (they are its parent's).
      if (ITEMS_RULES.has(write.rule) || (CATALOG_DELETES.has(write.rule) && catalog.isSegment !== true)) return itemsWriterProblem(connectionId, id)
      if (write.rule === 'catalog.agencies.share') {
        const keys = formKeys(write.body)
        if ((keys.has('enabled_collab_terms') || keys.has('utm_settings')) && catalog.isSegment !== true) return say(NOT_ALLOWED, `collaborative-ads terms and UTM settings go only with the share of a catalog segment, and ${id} is not one Meta names a segment.`)
        // Review A6 — a segment is shared with MANAGE and / or ADVERTISE only (collaborative-ads.md).
        if (catalog.isSegment === true) {
          let tasks: unknown
          try { tasks = JSON.parse(formOf(write.body).get('permitted_tasks') ?? '') } catch { tasks = null }
          if (!Array.isArray(tasks) || !tasks.every((t) => t === 'MANAGE' || t === 'ADVERTISE')) return say(NOT_ALLOWED, `catalog segment ${id} is shared with MANAGE and / or ADVERTISE only (Meta's collaborative ads).`)
        }
      }
      return null
    }
    case 'productset': {
      const catalogId = await catalogOfChild(io, id, 'id,product_catalog{id},filter', 'product set')
      if (isProblem(catalogId)) return catalogId
      const catalog = await writableHere(io, catalogId, business)
      return isProblem(catalog) ? catalog : null
    }
    case 'productitem': {
      const catalogId = await catalogOfChild(io, id, 'id,product_catalog{id},retailer_id,availability', 'item')
      if (isProblem(catalogId)) return catalogId
      const catalog = await writableHere(io, catalogId, business)
      if (isProblem(catalog)) return catalog
      if (catalog.isSegment !== false) return say(NOT_ALLOWED, `item ${id} is in a catalog segment (or Meta does not say whether its catalog is one): Nexus deletes no items there.`)
      return itemsWriterProblem(connectionId, catalogId)
    }
    case 'productfeed': {
      if (!parent || parent.kind !== 'catalog' || !/^\d{1,20}$/.test(parent.id)) return say(NOT_ALLOWED, `a change of feed ${id} names the catalog it belongs to.`)
      const catalog = await writableHere(io, parent.id, business)
      if (isProblem(catalog)) return catalog
      const feeds = await listedIds(io, `${parent.id}/product_feeds`, {}, PAGES)
      if (!feeds) return say(UNCONFIRMED, `Nexus could not read the feeds of catalog ${parent.id}.`)
      if (!feeds.has(id)) return say(NOT_CHOSEN, `${id} is not a feed of catalog ${parent.id}.`)
      const feed = await io.read(id, { fields: 'id,ingestion_source_type' })
      if (!feed || idOf(feed) !== id) return say(UNCONFIRMED, `Nexus could not read feed ${id}.`)
      return /supplementary/i.test(String(feed.ingestion_source_type ?? '')) ? null
        : say(NOT_ALLOWED, `feed ${id} is not a supplementary feed: deleting a primary feed disables every ad of the items it brings (Meta), and Nexus deletes no items it does not write (D7).`)
    }
  }
  return say(NOT_ALLOWED, `${id} is not a catalog object Nexus checks.`)
}

/** Why an id inside a catalog change's body is refused, or null. One list read per kind is kept for the whole body. */
export function metaCatalogBodyChecker(connectionId: string, write: MetaJudgedWrite, io: MetaOwnerIo) {
  const lists = new Map<string, Promise<Set<string> | null>>()
  const once = (key: string, load: () => Promise<Set<string> | null>) => {
    if (!lists.has(key)) lists.set(key, load())
    return lists.get(key)!
  }
  let portfolio: Promise<string | MetaOwnerProblem> | undefined
  const catalogId = write.objectId
  return async (inner: MetaWriteBodyId): Promise<MetaOwnerProblem | null> => {
    portfolio ??= portfolioOf(io)
    const business = await portfolio
    if (isProblem(business)) return inside(business)
    switch (inner.kind) {
      case 'catalogparent': {
        const parent = await writableHere(io, inner.id, business)
        if (isProblem(parent)) return inside(parent)
        return parent.isSegment === false ? null : inside(say(NOT_ALLOWED, `catalog ${inner.id} is a segment itself (or Meta does not say): a segment is made from a catalog, not from a segment.`))
      }
      case 'catalogpixel': {
        const chosen = await io.chosenAdAccount()
        const pixels = await once('pixels', async () => (chosen ? listedIds(io, `act_${chosen}/adspixels`, {}, 2) : null))
        if (!pixels) return inside(say(UNCONFIRMED, 'Nexus could not read the chosen ad account\'s pixels.'))
        return pixels.has(inner.id) ? null : inside(say(NOT_CHOSEN, `pixel ${inner.id} is not one of the chosen ad account's own pixels.`))
      }
      case 'catalogsource': {
        const sources = await once('sources', () => listedIds(io, `${catalogId}/external_event_sources`, {}, 2))
        if (!sources) return inside(say(UNCONFIRMED, `Nexus could not read the pixels and apps connected to catalog ${catalogId}.`))
        return sources.has(inner.id) ? null : inside(say(NOT_ALLOWED, `${inner.id} is not connected to catalog ${catalogId}.`))
      }
      case 'catalogperson': {
        // Review A2 — never Nexus's own system user (fewer tasks would stop every Nexus catalog tool).
        const own = idOf(await io.read('me', { fields: 'id' }))
        if (!own) return inside(say(UNCONFIRMED, 'Nexus could not read which system user it is, so it changes no one\'s access to a catalog.'))
        if (own === inner.id) return inside(say(NOT_ALLOWED, `${inner.id} is Nexus's own system user: Nexus never changes its own access to a catalog. A person does that in Meta Business settings, if it is meant.`))
        const people = await once('people', async () => {
          const users = await listedIds(io, `${business}/business_users`, {}, 10)
          const system = await listedIds(io, `${business}/system_users`, {}, 10)
          return users && system ? new Set([...users, ...system]) : null
        })
        if (!people) return inside(say(UNCONFIRMED, 'Nexus could not read the people and system users of the chosen business portfolio.'))
        return people.has(inner.id) ? null : inside(say(NOT_CHOSEN, `${inner.id} is not a person or system user of the chosen business portfolio: Nexus gives catalog access only to them.`))
      }
      case 'catalogassignee': {
        const me = await io.read('me', { fields: 'id' })
        const own = idOf(me)
        if (!own) return inside(say(UNCONFIRMED, 'Nexus could not read which system user it is, so it takes no one off a catalog.'))
        if (own === inner.id) return inside(say(NOT_ALLOWED, `${inner.id} is Nexus's own system user: Nexus never changes its own access to a catalog (taken off, every Nexus catalog tool would stop). A person does that in Meta Business settings, if it is meant.`))
        const assigned = await once('assigned', () => listedIds(io, `${catalogId}/assigned_users`, { business }, PAGES))
        if (!assigned) return inside(say(UNCONFIRMED, `Nexus could not read who is assigned to catalog ${catalogId}.`))
        return assigned.has(inner.id) ? null : inside(say(NOT_ALLOWED, `${inner.id} is not assigned to catalog ${catalogId}.`))
      }
      case 'catalogagency': {
        if (inner.id === business) return inside(say(NOT_ALLOWED, 'that is this business\'s own business portfolio: a catalog is shared with a partner, not with its owner.'))
        if ((await takenIds('PORTFOLIO', [inner.id])).has(inner.id)) return inside(say(NOT_CHOSEN, `business portfolio ${inner.id} is used by another business in Nexus: Nexus never shares a catalog with it.`))
        return null
      }
      case 'catalogpartner': {
        const agencies = await once('agencies', () => listedIds(io, `${catalogId}/agencies`, {}, PAGES))
        if (!agencies) return inside(say(UNCONFIRMED, `Nexus could not read who catalog ${catalogId} is shared with.`))
        return agencies.has(inner.id) ? null : inside(say(NOT_ALLOWED, `catalog ${catalogId} is not shared with business portfolio ${inner.id}.`))
      }
      case 'catalogshop': {
        const shops = await once('shops', async () => {
          const page = await metaChosenPageOf(connectionId)
          if (!page) return null
          const accounts = await listedIds(io, `${page}/commerce_merchant_settings`, {}, 2)
          if (!accounts) return null
          const all = new Set<string>()
          for (const account of accounts) {
            const ids = await listedIds(io, `${account}/shops`, {}, 2)
            if (!ids) return null
            for (const shop of ids) all.add(shop)
          }
          return all
        })
        if (!shops) return inside(say(UNCONFIRMED, 'Nexus could not read the shops of the chosen Facebook Page (none chosen, or not readable).'))
        return shops.has(inner.id) ? null : inside(say(NOT_CHOSEN, `shop ${inner.id} is not a shop of the chosen Facebook Page.`))
      }
      default:
        return inside(say(NOT_ALLOWED, `${inner.id} is not an id Nexus checks here.`))
    }
  }
}
