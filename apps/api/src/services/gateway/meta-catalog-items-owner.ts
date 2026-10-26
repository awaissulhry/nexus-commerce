/**
 * Meta step 35 (2026-10-25) — the gateway's own checks of what an item or feed change names (meta-catalog-owner.ts hands
 * step 35's kinds here). The tool ran the same checks (marketing/meta-ads/live-catalog-items.ts) at the preview and when the
 * approved change runs; they run AGAIN here with the gateway's own reads, so a caller that skipped the tool still sends
 * nothing to another business's catalog, and nothing D7 forbids (step 12's writer check: a catalog Shopify or a partner
 * writes takes only the D7 columns, by an update-only labels file or a rule on one of them). A read that is refused, not a
 * success, or cut refuses the change.
 *
 *   object a change names
 *     catalogitems  `<catalog>/items_batch | localized_items_batch`: the catalog is this business's (step 34's check: owned
 *                   by the chosen account's portfolio, which no other Nexus business uses, shared with none), not a segment,
 *                   and Nexus may write its items (writableCatalog 'items').
 *     productgroup  `<group>`: its own product_catalog is such a catalog, not a segment, Nexus may write its items; a new
 *                   default item is one of the group's own items.
 *     catalogfeeds  `<catalog>/product_feeds` (a new feed): such a catalog, not a segment. A supplementary feed: its primary
 *                   feeds are primary data sources of this catalog, it fetches nothing on a schedule, its rules name D7
 *                   columns only (step 12's { rules } check too), and Nexus may add the D7 columns here; any other feed:
 *                   Nexus may write the catalog's items, or writes them alone (its own app and feeds it made), and a feed it
 *                   is migrated from is one of those own feeds.
 *     catalogfeed   `<feed>…` (the change names the feed's catalog: metaParent): such a catalog; the feed is in its own
 *                   feeds; a labels file (id + D7 columns, update-only) to a primary feed (never an override feed) or to
 *                   Nexus's own supplementary feed under the D7 check; a rule on a D7 column the same (a supplementary
 *                   feed takes no other rule); Nexus's own supplementary feed renamed; a file of items only to a primary
 *                   feed of items Nexus made (its record: kind products); every other change (a feed's settings, a URL
 *                   upload, an upload schedule, a rule on another field, the undo-delete) only of a feed Nexus made, on a
 *                   catalog it may write items in or writes alone.
 *     feedrule      `<rule>` (DELETE; metaParent the catalog): a rule of one of the catalog's feeds, by the same rule as a
 *                   rule's create (its attribute read live).
 *     feedupload    `<upload>/error_report`: an upload of one of the catalog's feeds.
 * Feeds Nexus made are its own change records (ownCatalogFeedIds), never ids a caller names.
 */
import type { MetaJudgedWrite } from './meta-calls.js'
import type { MetaOwnerIo, MetaOwnerProblem } from './meta-optimize-owner.js'
import { listedIds } from './meta-optimize-owner.js'
import { isProblem, portfolioOf, say, writableHere } from './meta-catalog-owner.js'
import type { MetaCatalogItemsKind } from './meta-catalog-rules.js'
import { META_D7_COLUMNS, metaFeedCreateRules, metaFeedFileColumns } from './meta-catalog-items-rules.js'

const NOT_CHOSEN = 'META_ACCOUNT_NOT_CHOSEN'
const UNCONFIRMED = 'META_ACCOUNT_UNCONFIRMED'
const NOT_ALLOWED = 'META_WRITE_NOT_ALLOWED'
const PAGES = 5
const idOf = (v: unknown): string | null => {
  const raw = v && typeof v === 'object' ? (v as Record<string, unknown>).id : v
  return (typeof raw === 'string' || typeof raw === 'number') && /^\d{1,25}$/.test(String(raw)) ? String(raw) : null
}
const form = (body: string) => new URLSearchParams(body)
const D7: ReadonlySet<string> = new Set(META_D7_COLUMNS)

/** The account the D7 checks run for, and the feeds Nexus made on this catalog (its own records, with their kinds). */
async function writeContext(connectionId: string, catalogId: string) {
  const { metaChosenAccount } = await import('../marketing/meta-ads/live.js')
  const live = await import('../marketing/meta-ads/live-catalog-items.js')
  const account = await metaChosenAccount(connectionId)
  const ownFeeds = await live.ownCatalogFeeds(catalogId, account.adAccountId)
  return { account, live, ownFeedIds: [...ownFeeds.keys()], ownFeeds }
}

/** A check of the live module, its refusal kept in its own words; a check that cannot be made sends nothing. */
async function checked(work: () => Promise<unknown>, what: string): Promise<MetaOwnerProblem | null> {
  try {
    await work()
    return null
  } catch (err) {
    const { MetaLiveRefusal } = await import('../marketing/meta-ads/live.js')
    if (err instanceof MetaLiveRefusal) return say(NOT_ALLOWED, err.message)
    return say(UNCONFIRMED, `Nexus could not check ${what} (${err instanceof Error ? err.message : String(err)}), so it changes nothing.`)
  }
}

/** D7 'items': step 12's writer check lets Nexus write this catalog's items. */
async function itemsProblem(connectionId: string, catalogId: string): Promise<MetaOwnerProblem | null> {
  return checked(async () => {
    const { account, live } = await writeContext(connectionId, catalogId)
    await live.itemsWriteCheck(account, catalogId)
  }, `who writes catalog ${catalogId}`)
}

/** A feed that brings items: Nexus may write the catalog's items, or writes them alone (its app and its own feeds). */
async function feedItemsProblem(connectionId: string, catalogId: string): Promise<MetaOwnerProblem | null> {
  return checked(async () => {
    const { account, live, ownFeedIds } = await writeContext(connectionId, catalogId)
    await live.feedWriteCheck(account, catalogId, ownFeedIds)
  }, `who writes catalog ${catalogId}`)
}

/** The D7 columns (a labels file, or a rule on one of them): step 12's { upload } / { rules } purpose. */
async function d7Problem(connectionId: string, catalogId: string, use: { upload: string[] } | { rules: string[] }): Promise<MetaOwnerProblem | null> {
  return checked(async () => {
    const { account, live, ownFeedIds } = await writeContext(connectionId, catalogId)
    if ('upload' in use) await live.d7WriteCheck(account, catalogId, use.upload, ownFeedIds)
    else await live.d7RulesCheck(account, catalogId, use.rules, ownFeedIds)
  }, `who writes catalog ${catalogId}`)
}

async function ownFeeds(connectionId: string, catalogId: string): Promise<Map<string, string | null> | MetaOwnerProblem> {
  try {
    return (await writeContext(connectionId, catalogId)).ownFeeds
  } catch (err) {
    return say(UNCONFIRMED, `Nexus could not read which feeds it made on catalog ${catalogId} (${err instanceof Error ? err.message : String(err)}).`)
  }
}

/** The catalog a change of an item group, feed, rule or upload belongs to: checked as step 34 checks a catalog. */
async function catalogHere(io: MetaOwnerIo, catalogId: string | null, business: string, word: string): Promise<{ catalogId: string } | MetaOwnerProblem> {
  if (!catalogId || !/^\d{1,20}$/.test(catalogId)) return say(NOT_ALLOWED, `a change of a ${word} names the catalog it belongs to.`)
  const catalog = await writableHere(io, catalogId, business)
  if (isProblem(catalog)) return catalog
  if (catalog.isSegment !== false) return say(NOT_ALLOWED, `catalog ${catalogId} is a segment of another catalog (or Meta does not say whether it is one): its items and feeds live in the parent, so Nexus changes no ${word} here.`)
  return { catalogId }
}

/** The feed's kind as Meta reads it (supplementary or not, an override feed or not), confirmed among the catalog's own feeds. */
async function feedOfCatalog(io: MetaOwnerIo, catalogId: string, feedId: string): Promise<{ supplementary: boolean; override: boolean } | MetaOwnerProblem> {
  const feeds = await listedIds(io, `${catalogId}/product_feeds`, {}, PAGES)
  if (!feeds) return say(UNCONFIRMED, `Nexus could not read the feeds of catalog ${catalogId}.`)
  if (!feeds.has(feedId)) return say(NOT_CHOSEN, `${feedId} is not a feed of catalog ${catalogId}.`)
  const feed = await io.read(feedId, { fields: 'id,ingestion_source_type,override_type' })
  if (!feed || idOf(feed) !== feedId) return say(UNCONFIRMED, `Nexus could not read feed ${feedId}.`)
  const override = typeof feed.override_type === 'string' && feed.override_type.trim() !== ''
  return { supplementary: /supplementary/i.test(String(feed.ingestion_source_type ?? '')), override }
}

/** What a feed of this catalog may take, by the change's rule (the feed confirmed among the catalog's own feeds first). */
async function feedChangeProblem(connectionId: string, io: MetaOwnerIo, write: MetaJudgedWrite, catalogId: string, feedId: string): Promise<MetaOwnerProblem | null> {
  const feed = await feedOfCatalog(io, catalogId, feedId)
  if (isProblem(feed)) return feed
  const own = await ownFeeds(connectionId, catalogId)
  if (isProblem(own)) return own
  const mine = own.has(feedId)
  const notMine = say(NOT_ALLOWED, `feed ${feedId} is not one Nexus made: Nexus changes no other feed's settings, schedules or items (a Shopify or partner feed is theirs; D7). A labels upload adds the D7 columns to it.`)
  switch (write.rule) {
    case 'catalog.feed.upload.file': {
      const columns = write.multipart ? metaFeedFileColumns(write.multipart.file.text) : null
      if (!columns) return say(NOT_ALLOWED, 'the upload carries no file Nexus wrote.')
      if (write.multipart!.file.filename === 'nexus-labels.csv') {
        // A labels file goes to a primary feed (the Shopify feed) or to Nexus's own supplementary feed only — never to an
        // override feed (its file is an override's, review B-F5).
        if (feed.supplementary && !mine) return say(NOT_ALLOWED, `feed ${feedId} is a supplementary feed Nexus did not make: Nexus never writes into another source's supplementary feed (it would fight it for the columns).`)
        if (feed.override) return say(NOT_ALLOWED, `feed ${feedId} is a country or language override feed: a labels file goes to the feed that brings the items, or to Nexus's own supplementary feed.`)
        if (!columns.every((c) => c === 'id' || D7.has(c))) return say(NOT_ALLOWED, 'a labels file carries id and the D7 columns only.')
        return d7Problem(connectionId, catalogId, { upload: columns })
      }
      if (!mine) return notMine
      // Review B-F5 — a file of items goes only to a primary feed of items Nexus made (its record: kind products): an
      // override, offers, ratings or local-inventory feed has columns of its own (url uploads only).
      if (feed.supplementary || feed.override || own.get(feedId) !== 'products') return say(NOT_ALLOWED, `feed ${feedId} is not a primary feed of items Nexus made (kind products): a file of items goes only to one; other feeds take an upload from an address.`)
      return feedItemsProblem(connectionId, catalogId)
    }
    case 'catalog.feed.rule.create': {
      const attribute = form(write.body).get('attribute') ?? ''
      // Review A-F1 (D7): a supplementary feed's rules shape what it adds to the primary source's items: D7 columns only.
      if (feed.supplementary && !D7.has(attribute)) return say(NOT_ALLOWED, `feed ${feedId} is a supplementary feed: its rules name the D7 columns only (${META_D7_COLUMNS.join(', ')}), never ${attribute || 'another field'}.`)
      if (D7.has(attribute)) {
        if (feed.supplementary && !mine) return say(NOT_ALLOWED, `feed ${feedId} is a supplementary feed Nexus did not make: Nexus adds no rule to it.`)
        return d7Problem(connectionId, catalogId, { rules: [attribute] })
      }
      if (!mine) return notMine
      return feedItemsProblem(connectionId, catalogId)
    }
    case 'catalog.feed.update': {
      if (!mine) return notMine
      const keys = [...form(write.body).keys()]
      // Nexus's own supplementary feed renamed: a setting, no item.
      if (feed.supplementary && keys.every((k) => k === 'name')) return null
      if (feed.supplementary) return say(NOT_ALLOWED, 'Nexus\'s own supplementary feed takes a new name only (a schedule would fetch a file Nexus does not make).')
      return feedItemsProblem(connectionId, catalogId)
    }
    case 'catalog.feed.delete.made':
      // The undo of a feed Nexus made: only that feed (its own record), whatever writes the catalog now.
      return mine ? null : notMine
    case 'catalog.feed.upload.url':
    case 'catalog.feed.uploadSchedule':
      if (!mine) return notMine
      if (feed.supplementary) return say(NOT_ALLOWED, 'Nexus\'s own supplementary feed takes only labels files Nexus writes (a file at an address decides its own columns).')
      return feedItemsProblem(connectionId, catalogId)
  }
  return say(NOT_ALLOWED, `${write.rule} is not a feed change Nexus checks.`)
}

/** Why a step 35 catalog change of this object is refused for this connection, or null. */
export async function metaCatalogItemsOwnerProblem(
  connectionId: string, write: MetaJudgedWrite, kind: MetaCatalogItemsKind, io: MetaOwnerIo, parent?: { kind: string; id: string },
): Promise<MetaOwnerProblem | null> {
  const id = write.objectId
  const business = await portfolioOf(io)
  if (isProblem(business)) return business
  const parentCatalog = parent?.kind === 'catalog' ? parent.id : null
  switch (kind) {
    case 'catalogitems': {
      const catalog = await catalogHere(io, id, business, 'catalog\'s items')
      if (isProblem(catalog)) return catalog
      return itemsProblem(connectionId, id)
    }
    case 'productgroup': {
      const body = await io.read(id, { fields: 'id,product_catalog{id},retailer_id,variants' })
      const catalogId = idOf(body?.product_catalog)
      if (!body || idOf(body) !== id || !catalogId) return say(UNCONFIRMED, `Nexus could not read ${id} as an item group of a Meta catalog.`)
      const catalog = await catalogHere(io, catalogId, business, 'item group')
      if (isProblem(catalog)) return catalog
      if (write.rule === 'productgroup.default') {
        const item = form(write.body).get('default_product_id') ?? ''
        const items = await listedIds(io, `${id}/products`, {}, PAGES)
        if (!items) return say(UNCONFIRMED, `Nexus could not read the items of group ${id}.`)
        if (!items.has(item)) return say(NOT_ALLOWED, `${item} is not an item of group ${id}: a group's default is one of its own items.`)
      }
      return itemsProblem(connectionId, catalogId)
    }
    case 'catalogfeeds': {
      const catalog = await catalogHere(io, id, business, 'feed')
      if (isProblem(catalog)) return catalog
      const body = form(write.body)
      if (body.get('ingestion_source_type') === 'SUPPLEMENTARY_FEED') {
        if (body.has('schedule') || body.has('update_schedule')) return say(NOT_ALLOWED, 'Nexus\'s supplementary feed fetches nothing on a schedule: it takes labels files Nexus writes.')
        let primaries: string[] = []
        try { primaries = JSON.parse(body.get('primary_feed_ids') ?? '[]') as string[] } catch { primaries = [] }
        const sources = await listedIds(io, `${id}/data_sources`, { ingestion_source_type: 'PRIMARY' }, PAGES)
        if (!sources) return say(UNCONFIRMED, `Nexus could not read the primary data sources of catalog ${id}.`)
        const foreign = primaries.filter((p) => !sources.has(p))
        if (!primaries.length || foreign.length) return say(NOT_ALLOWED, `${foreign.join(', ') || 'no feed'} ${foreign.length === 1 ? 'is' : 'are'} not a primary data source of catalog ${id}: a supplementary feed adds fields to this catalog's own primary sources.`)
        // Review A-F1 (D7): its rules (if any) name the D7 columns only, under step 12's { rules } check as well.
        const rules = body.has('rules') ? metaFeedCreateRules(body.get('rules') ?? '') : []
        if (!rules) return say(NOT_ALLOWED, 'the new feed\'s rules are not a list Nexus wrote.')
        const attributes = [...new Set(rules.map((r) => String(r.attribute)))]
        const outside = attributes.filter((a) => !D7.has(a))
        if (outside.length) return say(NOT_ALLOWED, `a supplementary feed's rules name the D7 columns only (${META_D7_COLUMNS.join(', ')}): not ${outside.join(', ')} (Shopify, or another source, writes those).`)
        const upload = await d7Problem(connectionId, id, { upload: ['id', 'internal_label'] })
        if (upload || !attributes.length) return upload
        return d7Problem(connectionId, id, { rules: attributes })
      }
      const migrated = body.get('migrated_from_feed_id')
      if (migrated) {
        const own = await ownFeeds(connectionId, id)
        if (isProblem(own)) return own
        if (!own.has(migrated)) return say(NOT_ALLOWED, `feed ${migrated} is not one Nexus made on catalog ${id}: Nexus moves items only out of its own feeds.`)
      }
      return feedItemsProblem(connectionId, id)
    }
    case 'catalogfeed': {
      const catalog = await catalogHere(io, parentCatalog, business, 'feed')
      if (isProblem(catalog)) return catalog
      return feedChangeProblem(connectionId, io, write, catalog.catalogId, id)
    }
    case 'feedrule': {
      const catalog = await catalogHere(io, parentCatalog, business, 'feed rule')
      if (isProblem(catalog)) return catalog
      const feeds = await listedIds(io, `${catalog.catalogId}/product_feeds`, {}, PAGES)
      if (!feeds) return say(UNCONFIRMED, `Nexus could not read the feeds of catalog ${catalog.catalogId}.`)
      for (const feedId of feeds) {
        const rules = await listedIds(io, `${feedId}/rules`, {}, 2)
        if (!rules) return say(UNCONFIRMED, `Nexus could not read the rules of feed ${feedId}.`)
        if (!rules.has(id)) continue
        const rule = await io.read(id, { fields: 'id,attribute' })
        const attribute = typeof rule?.attribute === 'string' ? rule.attribute : null
        if (!rule || idOf(rule) !== id || !attribute) return say(UNCONFIRMED, `Nexus could not read rule ${id}.`)
        // The delete of a rule is judged as its create would be (the same feed, the same attribute).
        return feedChangeProblem(connectionId, io, { ...write, rule: 'catalog.feed.rule.create', body: new URLSearchParams({ attribute }).toString() }, catalog.catalogId, feedId)
      }
      return say(NOT_CHOSEN, `${id} is not a rule of a feed of catalog ${catalog.catalogId}.`)
    }
    case 'feedupload': {
      const catalog = await catalogHere(io, parentCatalog, business, 'feed upload')
      if (isProblem(catalog)) return catalog
      const feeds = await listedIds(io, `${catalog.catalogId}/product_feeds`, {}, PAGES)
      if (!feeds) return say(UNCONFIRMED, `Nexus could not read the feeds of catalog ${catalog.catalogId}.`)
      for (const feedId of feeds) {
        const uploads = await listedIds(io, `${feedId}/uploads`, {}, PAGES)
        if (uploads?.has(id)) return null
      }
      return say(NOT_CHOSEN, `${id} is not one of the newest uploads of a feed of catalog ${catalog.catalogId}.`)
    }
  }
  return say(NOT_ALLOWED, `${id} is not a catalog object Nexus checks.`)
}
