/**
 * Meta ads step 12 (2026-10-21) — Claude's reads of Meta catalogs. Read only: nothing here changes Meta, and the gateway
 * lets only GET through. A catalog is read only when the business's chosen ad account's business portfolio owns it (or it
 * is a client catalog of that portfolio) and no other business in Nexus uses that portfolio; every id below a catalog is
 * checked to be in a readable catalog before it is read (marketing/meta-ads/live-catalog.ts). A caller never names a
 * Graph field or path.
 *
 *   meta-catalogs        the portfolio's catalogs, one catalog's settings, WHO writes it (D7: Shopify, a feed, an app, the
 *                        smart pixel), its data sources, segments, pixels and apps (and the catalogs of each pixel),
 *                        people, partners, collaborative ads, bundle folders, smart pixel, the chosen Page's and its
 *                        shop's catalogs; Meta's category list is a file, not an API (master CT-001…005, CT-010, CT-013,
 *                        CT-016, CT-095, CT-120, CT-130…133, CT-178, CT-190, CT-192, CT-901, CT-902, CT-905, CT-932,
 *                        SG-121)
 *   meta-catalog-items   items (by SKU, name, availability, review status, error), one item (as a country or language
 *                        sees it), its overrides, status per channel, product sets, videos, a feed's items, item groups,
 *                        batch results (CT-020…029, CT-040, CT-050, CT-051, CT-069a, CT-105, CT-176, CT-904)
 *   meta-catalog-feeds   feeds, schedules, uploads, upload errors, suggested rules, feed rules (CT-070…073, CT-080…082,
 *                        CT-086, CT-091)
 *   meta-catalog-health  diagnostics, items behind a problem, rejected items, event match rate and the sources ranked,
 *                        Meta's catalog-ads checks on a pixel, eligible ad accounts, one readiness answer (CT-110…115,
 *                        CT-900, CT-934)
 * Items carry prices: minor units of each item's own currency under restricted keys (financials.revenue.view — the one
 * financial grain Nexus gives a selling price, averageSellingPrice; Nexus's own product prices are operational, gated by
 * pricing.view, which is not a field permission). This fails safe; the leader / Owner may relax it. No other answer holds
 * money. Not masked yet (fix A7): pixels and apps (no PIXEL taken kind) and suggested-partner brands — a later step.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { connectionArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'
import {
  CATALOG_VIEWS, CONNECTION_METHODS, DA_CHECKS, DATA_SOURCE_TYPES, DIAGNOSTIC_CHANNELS, DIAGNOSTIC_ENTITIES, DIAGNOSTIC_SEVERITIES, DIAGNOSTIC_TYPES,
  ERROR_PRIORITIES, FEED_VIEWS, HEALTH_VIEWS, ITEM_AVAILABILITY, ITEM_REVIEW_STATUSES, ITEM_VIEWS, liveCatalogFeeds, liveCatalogHealth, liveCatalogItems,
  liveCatalogs, OVERRIDE_TYPES, type CatalogsInput, type FeedsInput, type HealthInput, type ItemsInput,
} from '../../marketing/meta-ads/live-catalog.js'
import { META_ITEM_ERROR_TYPES } from '../../meta/meta-catalog-lists.js'

const REVENUE = FIELDS.financialsRevenueView
/** The item prices of meta-catalog-items (minor units of the item's currency, and Meta's own text). */
export const META_CATALOG_MONEY = { priceCents: REVENUE, salePriceCents: REVENUE, priceShown: REVENUE, salePriceShown: REVENUE, otherPriceShown: REVENUE } as const

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const maxRowsArg = (dflt: number) => z.number().int().min(1).max(500).optional().describe(`at most this many rows (default ${dflt}, at most 500)`)
const catalogArg = (what: string) => metaIdArg(`${what} (Meta's catalog id, from meta-catalogs view list)`)
const priorityArg = (what: string) => z.preprocess(upper, z.enum(ERROR_PRIORITIES)).optional().describe(`${what}: HIGH | MEDIUM | LOW`)
// Fix B5 — Meta's own enum of item error types (services/meta/meta-catalog-lists.ts), not a free text.
const errorTypeArg = z.preprocess(upper, z.enum(META_ITEM_ERROR_TYPES)).optional()
  .describe('only items with this Meta error type (Meta\'s enum, e.g. IMAGE_RESOLUTION_LOW, INACTIVE_SHOPIFY_PRODUCT, PRODUCT_OUT_OF_STOCK)')
const enumList = <T extends readonly [string, ...string[]]>(values: T, what: string) => z.array(z.enum(values)).max(values.length).optional().describe(`${what}: ${values.join(' | ')}`)

const READ_ONLY = { category: 'insights', riskTier: 'low', readOnly: true, openWorld: true } as const

// ── meta-catalogs ────────────────────────────────────────────────────────────────────────────────────────────────

const metaCatalogs: AgentTool = {
  name: 'meta-catalogs',
  title: 'Meta catalogs',
  ...READ_ONLY,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(CATALOG_VIEWS)).describe(CATALOG_VIEWS.join(' | ')),
    catalogId: catalogArg('catalog, writer, data-sources, segments, people, partners, bundle-folders, smart-pixel: the catalog; event-sources: one catalog (default every catalog, grouped by pixel); collaborative: also its share settings'),
    sourceType: z.preprocess(upper, z.enum(DATA_SOURCE_TYPES)).optional().describe('data-sources: ALL (default) | PRIMARY | SUPPLEMENTARY'),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'The business\'s Meta catalogs, read LIVE. A catalog is read only when the chosen ad account\'s business portfolio owns it '
    + 'or it is a client catalog of that portfolio, and no other business in Nexus uses that portfolio (when one does, '
    + 'nothing is read: a per-business catalog choice is needed). view list: the portfolio\'s own and client catalogs '
    + '(segments marked) and who writes each. catalog (catalogId): settings, images, shop settings, owner. writer: WHO '
    + 'writes the items — Shopify, another shop platform, a data feed, an app through the API (Nexus\'s own or not), the '
    + 'smart pixel, several, none or unknown — with the evidence; under the Owner\'s rule D7 Shopify keeps writing and '
    + 'Nexus writes no items on a catalog Shopify feeds (nexusMayWriteItems; only view writer decides it — list and catalog '
    + 'say null). data-sources (sourceType): every source '
    + '(Meta\'s default would be PRIMARY only; Nexus asks ALL). segments: segments made from it. event-sources: pixels and '
    + 'apps connected to a catalog, or without catalogId every catalog grouped by pixel (Meta has no list of a pixel\'s '
    + 'catalogs). people: people and system users with access. partners: agencies and businesses with a permission (one '
    + 'another business in Nexus uses is its id only). collaborative: collaborative-ads share settings, requests sent and '
    + 'received, suggested partners, set-up (answering a request is Ads Manager only). bundle-folders, smart-pixel '
    + '(settings, stats). page-catalogs: catalogs linked to the chosen Facebook Page; shop-catalogs: the catalogs of the '
    + 'Page\'s shops. categories: Meta\'s product category list is a file on facebook.com, not an API — the answer says '
    + 'where it is. Changing catalogs: create-meta-catalog, set-meta-catalog, set-meta-catalog-access and '
    + 'remove-meta-catalog-items. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveCatalogs({
      connectionId: str(args.connectionId),
      view: args.view as CatalogsInput['view'],
      catalogId: str(args.catalogId),
      sourceType: (args.sourceType as CatalogsInput['sourceType']) ?? null,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-catalog-items ───────────────────────────────────────────────────────────────────────────────────────────

const metaCatalogItems: AgentTool = {
  name: 'meta-catalog-items',
  title: 'Meta catalog items',
  ...READ_ONLY,
  requires: [F.adsView],
  restrictedFields: META_CATALOG_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(ITEM_VIEWS)).describe(ITEM_VIEWS.join(' | ')),
    catalogId: catalogArg('list, groups, batch-status, sets-batch-status: the catalog; feed-items: the feed\'s catalog; item views: optional, checked'),
    itemId: metaIdArg('item, overrides, channels, item-sets, item-videos: Meta\'s item id (from view list; a SKU is the skus filter)'),
    feedId: metaIdArg('feed-items: the feed (from meta-catalog-feeds view list)'),
    groupId: metaIdArg('group: the item group (from view groups)'),
    skus: z.array(z.string().trim().min(1).max(100)).max(100).optional().describe('list, feed-items: only these SKUs (Meta\'s retailer_id; how an item is found by SKU)'),
    groupSku: z.string().trim().min(1).max(100).optional().describe('list, feed-items: only this item group (the items\' item_group_id)'),
    nameContains: z.string().trim().min(1).max(100).optional().describe('list, feed-items: only items whose title contains this (any case)'),
    availability: z.preprocess(lower, z.enum(ITEM_AVAILABILITY)).optional().describe(`list, feed-items: ${ITEM_AVAILABILITY.join(' | ')}`),
    reviewStatus: z.preprocess(lower, z.enum(ITEM_REVIEW_STATUSES)).optional().describe('list, feed-items: pending | rejected | approved | outdated'),
    errorType: errorTypeArg,
    errorPriority: priorityArg('list, feed-items: only items with errors of this priority'),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/).optional().describe('item: the item as Meta shows it in this country (ISO code, e.g. IT: its country price and availability)'),
    language: z.string().trim().regex(/^[a-z]{2,3}_[A-Z]{2}$/).optional().describe('item: the item as Meta shows it in this language (e.g. it_IT, fr_XX: its translated text)'),
    overrideType: z.preprocess(upper, z.enum(OVERRIDE_TYPES)).optional().describe('overrides: COUNTRY | LANGUAGE | LANGUAGE_AND_COUNTRY'),
    overrideKeys: z.array(z.string().trim().regex(/^[A-Za-z_]{2,10}$/)).max(50).optional().describe('overrides: only these countries or languages (e.g. IT, it_IT)'),
    handle: z.string().trim().regex(/^[A-Za-z0-9_\-:.=+/]{1,300}$/).optional().describe('batch-status, sets-batch-status: the handle the batch answered'),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'Items of the business\'s Meta catalogs, read LIVE (only a catalog meta-catalogs reads; an item, group or feed is '
    + 'checked to be in one before it is read). view list (catalogId): items with price, availability, review status and '
    + 'errors; skus finds items by SKU, groupSku / nameContains / availability / reviewStatus / errorType / errorPriority '
    + 'narrow it. item (itemId): every field, as a country (country) or language (language) sees it, its review per channel, '
    + 'Meta\'s AI background images, video fetch status, and whether a feed or an app writes it. overrides: its country and '
    + 'language overrides. channels: status per channel (ads, shops, Instagram tagging). item-sets: the product sets it is '
    + 'in. item-videos: its video fetch data. feed-items (feedId): one feed\'s items. groups, group (groupId): item groups '
    + 'and their variants. batch-status (catalogId, handle): what became of an items batch (Finished: rows with errors were '
    + 'NOT saved); sets-batch-status: a product-sets batch. Prices are minor units of each item\'s currency (priceCents) '
    + 'with Meta\'s own text (priceShown). Meta cannot: read "additional reviews" (it is an appeal, a change); find an item by '
    + 'a catalog:<id>:<SKU> address (a preview token only — use skus). Changing items is set-meta-catalog-items '
    + '(on a catalog Shopify feeds Nexus writes no items, D7; deleting them: remove-meta-catalog-items). Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveCatalogItems({
      connectionId: str(args.connectionId),
      view: args.view as ItemsInput['view'],
      catalogId: str(args.catalogId),
      itemId: str(args.itemId),
      feedId: str(args.feedId),
      groupId: str(args.groupId),
      skus: args.skus as string[] | undefined,
      groupSku: str(args.groupSku),
      nameContains: str(args.nameContains),
      availability: str(args.availability),
      reviewStatus: str(args.reviewStatus),
      errorType: str(args.errorType),
      errorPriority: (args.errorPriority as ItemsInput['errorPriority']) ?? null,
      country: str(args.country),
      language: str(args.language),
      overrideType: (args.overrideType as ItemsInput['overrideType']) ?? null,
      overrideKeys: args.overrideKeys as string[] | undefined,
      handle: str(args.handle),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-catalog-feeds ───────────────────────────────────────────────────────────────────────────────────────────

const metaCatalogFeeds: AgentTool = {
  name: 'meta-catalog-feeds',
  title: 'Meta catalog feeds',
  ...READ_ONLY,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(FEED_VIEWS)).describe(FEED_VIEWS.join(' | ')),
    catalogId: catalogArg('every view: the catalog'),
    feedId: metaIdArg('feed, schedules, uploads, upload, upload-errors, suggested-rules, rules: the feed (from view list)'),
    uploadId: metaIdArg('upload, upload-errors, suggested-rules: the upload (from view uploads)'),
    errorId: metaIdArg('suggested-rules: the upload error (from view upload-errors)'),
    errorPriority: priorityArg('upload-errors: HIGH = fatal only; MEDIUM or LOW = every warning'),
    maxRows: maxRowsArg(50),
    connectionId: connectionArg,
  }),
  description:
    'Data feeds of the business\'s Meta catalogs, read LIVE (only a catalog meta-catalogs reads; a feed must be in the '
    + 'catalog\'s own list, an upload in its feed\'s, an error in its upload\'s). view list (catalogId): feeds with their kind '
    + '(primary adds and removes items; supplementary changes fields only), country or language override, schedules and '
    + 'latest upload. feed (feedId): every setting — deletion_enabled, once on, can never be turned off (a full upload then '
    + 'deletes items missing from the file). schedules: extra upload schedules (add and update only). uploads, upload '
    + '(uploadId): what each upload found, saved, refused and deleted. upload-errors: a sample of an upload\'s errors '
    + '(fatal: the item was not made) and warnings. suggested-rules (errorId): Meta\'s suggested fixes for one error. '
    + 'rules: the feed\'s rules. Fetch addresses are shown by host only (they may hold a key). Changing feeds is '
    + 'set-meta-catalog-feed (deleting a supplementary feed: remove-meta-catalog-items). Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveCatalogFeeds({
      connectionId: str(args.connectionId),
      view: args.view as FeedsInput['view'],
      catalogId: str(args.catalogId),
      feedId: str(args.feedId),
      uploadId: str(args.uploadId),
      errorId: str(args.errorId),
      errorPriority: (args.errorPriority as FeedsInput['errorPriority']) ?? null,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-catalog-health ──────────────────────────────────────────────────────────────────────────────────────────

const metaCatalogHealth: AgentTool = {
  name: 'meta-catalog-health',
  title: 'Meta catalog health',
  ...READ_ONLY,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(HEALTH_VIEWS)).describe(HEALTH_VIEWS.join(' | ')),
    catalogId: catalogArg('every view: the catalog'),
    sourceId: metaIdArg('pixel-checks: a pixel or app connected to the catalog (from meta-catalogs view event-sources)'),
    types: enumList(DIAGNOSTIC_TYPES, 'diagnostics: only these kinds'),
    severities: enumList(DIAGNOSTIC_SEVERITIES, 'diagnostics: only these'),
    channels: enumList(DIAGNOSTIC_CHANNELS, 'diagnostics: only problems on these channels (da = catalog ads)'),
    entities: enumList(DIAGNOSTIC_ENTITIES, 'diagnostics: only problems of these'),
    errorType: errorTypeArg,
    errorPriority: priorityArg('problem-items: the priority (default HIGH)'),
    byDevice: z.boolean().optional().describe('match-rate: split by device type'),
    checks: enumList(DA_CHECKS, 'pixel-checks: only these checks (default all)'),
    connectionMethod: z.preprocess(upper, z.enum(CONNECTION_METHODS)).optional().describe('pixel-checks: ALL | APP | BROWSER | SERVER'),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'Health of one of the business\'s Meta catalogs for catalog (Advantage+) ads, read LIVE (only a catalog meta-catalogs '
    + 'reads). view readiness: one answer — is it ready, what blocks it (no items, MUST_FIX problems, no pixel), what to '
    + 'improve (rejected items, events that do not match, failed checks, the chosen ad account not found eligible, feed upload '
    + 'errors or deletions) and who writes it (D7); a part Meta refuses is named. diagnostics (types, severities, channels, '
    + 'entities): Meta\'s problems with item counts (event source problems are updated daily). problem-items (errorType, '
    + 'errorPriority): the items behind a problem, worst first. rejected: items rejected in review and why. match-rate '
    + '(byDevice): how pixel and app events match the items, per day, and the sources ranked by matched share '
    + '(Meta has no public call that recommends sources; Meta may answer this only with full Marketing API access). '
    + 'pixel-checks (sourceId): Meta\'s catalog-ads checks on a pixel or app. eligible-accounts: ad accounts that may run '
    + 'catalog ads with it, and whether the chosen one may (true, or null when Meta\'s search did not find it: not known). No prices here (meta-catalog-items). Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveCatalogHealth({
      connectionId: str(args.connectionId),
      view: args.view as HealthInput['view'],
      catalogId: str(args.catalogId),
      sourceId: str(args.sourceId),
      types: args.types as string[] | undefined,
      severities: args.severities as string[] | undefined,
      channels: args.channels as string[] | undefined,
      entities: args.entities as string[] | undefined,
      errorType: str(args.errorType),
      errorPriority: (args.errorPriority as HealthInput['errorPriority']) ?? null,
      byDevice: args.byDevice as boolean | undefined,
      checks: args.checks as string[] | undefined,
      connectionMethod: (args.connectionMethod as HealthInput['connectionMethod']) ?? null,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

export const META_ADS_CATALOG_TOOLS: AgentTool[] = [metaCatalogs, metaCatalogItems, metaCatalogFeeds, metaCatalogHealth]
