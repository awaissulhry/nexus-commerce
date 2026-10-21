/**
 * Meta ads step 13 (2026-10-21) — Claude's reads of product sets, commerce accounts and shops, and Instagram product
 * tags. Read only: nothing here changes Meta, and the gateway lets only GET through. The rules of what may be read live in
 * marketing/meta-ads/live-commerce.ts (step 12's readable-catalog rule and set check; step 10's chosen Instagram account
 * and its own media; the chosen Page's and the unshared portfolio's commerce accounts). A caller never names a Graph
 * field or path, and never sends Meta a filter: Nexus builds a product-set filter from typed conditions.
 *
 *   meta-product-sets           a catalog's product sets, one set, the items in a set, the preview of a filter (how many
 *                               items a set would hold, and a sample — Meta has no check on a set write), facets (master
 *                               CT-060…063, CT-903)
 *   meta-commerce               commerce accounts of the chosen Page and portfolio, one account's settings, its shops,
 *                               one shop, the shop set-up status, offsite checkout countries (CT-140, 141, 143, 144, 147)
 *   meta-instagram-product-tags whether the chosen Instagram account may tag products, the catalogs it may tag from,
 *                               product search, the tags on a post, a product's appeal state (CT-150…153, CT-157)
 * Items in a set and product tags carry prices: step 12's minor units under restricted keys (financials.revenue.view);
 * a set filter that names a price is answered only under filterWithPricesShown. meta-commerce holds no money.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { connectionArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'
import { META_CATALOG_MONEY } from './meta-ads-catalog.tools.js'
import {
  COMMERCE_VIEWS, IG_TAG_VIEWS, liveCommerce, liveInstagramProductTags, liveProductSets, MAX_SET_CONDITIONS, MAX_SET_VALUES, PRODUCT_SET_VIEWS,
  SET_ERROR_PRIORITIES, SET_FACET_FIELDS, SET_FILTER_FIELDS, SET_FILTER_OPS, type CommerceInput, type InstagramTagsInput, type ProductSetsInput, type SetCondition,
} from '../../marketing/meta-ads/live-commerce.js'

/** meta-product-sets: item prices (step 12's keys) and a set filter that names a price. */
export const META_PRODUCT_SET_MONEY = { ...META_CATALOG_MONEY, filterWithPricesShown: FIELDS.financialsRevenueView } as const

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const maxRowsArg = (dflt: number) => z.number().int().min(1).max(500).optional().describe(`at most this many rows (default ${dflt}, at most 500)`)
const catalogArg = (what: string) => metaIdArg(`${what} (Meta's catalog id, from meta-catalogs view list)`)

const READ_ONLY = { category: 'insights', riskTier: 'low', readOnly: true, openWorld: true } as const

// ── meta-product-sets ────────────────────────────────────────────────────────────────────────────────────────────

const conditionArg = z.object({
  field: z.preprocess(lower, z.enum(SET_FILTER_FIELDS)).describe(`the item field: ${SET_FILTER_FIELDS.join(' | ')} (price_amount, sale_price_amount: a price)`),
  op: z.preprocess(lower, z.enum(SET_FILTER_OPS)).describe('eq | neq | contains | not_contains | i_contains | is_any | is_not_any | starts_with (category only) | lt | lte | gt | gte (prices)'),
  value: z.string().max(200).optional().describe('the one value (eq, neq, contains, not_contains, i_contains, starts_with)'),
  values: z.array(z.string().max(200)).max(MAX_SET_VALUES).optional().describe('the values (is_any, is_not_any)'),
  amountMinor: z.number().int().min(0).max(1_000_000_000).optional().describe('a price condition: minor units of currency (4990 = 49.90)'),
})

const metaProductSets: AgentTool = {
  name: 'meta-product-sets',
  title: 'Meta product sets',
  ...READ_ONLY,
  requires: [F.adsView],
  restrictedFields: META_PRODUCT_SET_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(PRODUCT_SET_VIEWS)).describe(PRODUCT_SET_VIEWS.join(' | ')),
    catalogId: catalogArg('list, preview, facets: the catalog; set, items: optional, checked'),
    productSetId: metaIdArg('set, items: the product set (from view list); preview: optional — the set whose item count now is compared'),
    parentId: metaIdArg('list: only the sets directly under this set (0 = top-level sets)'),
    ancestorId: metaIdArg('list: only the sets below this set'),
    hasChildren: z.boolean().optional().describe('list: only sets with (true) or without (false) sets below them'),
    retailerId: z.string().trim().min(1).max(100).optional().describe('list: only the set with this retailer id (your own id for a set)'),
    conditions: z.array(conditionArg).max(MAX_SET_CONDITIONS).optional()
      .describe('preview: the filter a set would have; items, facets: narrow to these. Nexus builds Meta\'s rule from them (no condition = every item)'),
    match: z.preprocess(lower, z.enum(['all', 'any'])).optional().describe('conditions: all (default, and) | any (or)'),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional().describe('price conditions: the currency of amountMinor (default the ad account\'s)'),
    errorType: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,79}$/).optional().describe('items: only items with this Meta error type (e.g. IMAGE_RESOLUTION_LOW)'),
    errorPriority: z.preprocess(upper, z.enum(SET_ERROR_PRIORITIES)).optional().describe('items: only items with errors of this priority: HIGH | MEDIUM | LOW'),
    facetFields: z.array(z.enum(SET_FACET_FIELDS)).max(SET_FACET_FIELDS.length).optional()
      .describe(`facets: the fields to count (default brand, product_type, availability): ${SET_FACET_FIELDS.join(' | ')}`),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'Product sets of the business\'s Meta catalogs, read LIVE (only a catalog meta-catalogs reads; a set is checked to be '
    + 'in one before it is read). view list (catalogId; parentId 0 = top-level sets, ancestorId, hasChildren, retailerId): '
    + 'the sets with their filter in plain words and item count — an empty set\'s ads do not deliver. set (productSetId): '
    + 'one set with its metadata (live = what passed Meta\'s review). items (productSetId): the items in it now with '
    + 'prices, narrowed by conditions, errorType or errorPriority. preview (catalogId, conditions, match; productSetId to '
    + 'compare): Meta has no check for a set change, so this is the preview — how many items a set with this filter '
    + 'would hold, a sample, and the set\'s count now (before → after). facets (facetFields, conditions): distinct values '
    + 'and counts (brands, types…) to build a filter. Conditions are typed (field, op, value / values / amountMinor): Nexus '
    + 'builds Meta\'s rule and checks Meta\'s rules (contains is for text, fixed-value fields take eq / is_any, '
    + 'starts_with only on category, no non-English characters in label filters; a price is minor units, sent as Meta\'s '
    + 'price × 100). Prices are minor units of each item\'s currency (priceCents) with Meta\'s text; a set filter that '
    + 'names a price is under filterWithPricesShown. The sets an item is in: meta-catalog-items view item-sets. Changing '
    + 'sets is a change tool (a later Nexus step). Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveProductSets({
      connectionId: str(args.connectionId),
      view: args.view as ProductSetsInput['view'],
      catalogId: str(args.catalogId),
      productSetId: str(args.productSetId),
      parentId: str(args.parentId),
      ancestorId: str(args.ancestorId),
      hasChildren: typeof args.hasChildren === 'boolean' ? args.hasChildren : null,
      retailerId: str(args.retailerId),
      conditions: (args.conditions as SetCondition[] | undefined) ?? null,
      match: (args.match as ProductSetsInput['match']) ?? null,
      currency: str(args.currency),
      errorType: str(args.errorType),
      errorPriority: (args.errorPriority as ProductSetsInput['errorPriority']) ?? null,
      facetFields: (args.facetFields as string[] | undefined) ?? null,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-commerce ────────────────────────────────────────────────────────────────────────────────────────────────

const countryArg = z.string().trim().regex(/^[A-Za-z]{2}$/)

const metaCommerce: AgentTool = {
  name: 'meta-commerce',
  title: 'Meta commerce accounts and shops',
  ...READ_ONLY,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(COMMERCE_VIEWS)).describe(COMMERCE_VIEWS.join(' | ')),
    commerceAccountId: metaIdArg('account, shops, checkout-countries, setup-status: the commerce account (from view accounts; default the only one); shop: optional'),
    shopId: metaIdArg('shop: the shop (from view shops)'),
    country: countryArg.optional().describe('account: checkout, call to action and shop ads set-up for this country (ISO code, e.g. IT)'),
    countries: z.array(countryArg).max(5).optional().describe('checkout-countries: also the checkout set-up for these countries (at most 5)'),
    locale: z.string().trim().regex(/^[a-z]{2,3}(?:[-_][A-Z]{2})?$/).optional().describe('account: the privacy policy in this language (e.g. it, en_US)'),
    maxRows: maxRowsArg(25),
    connectionId: connectionArg,
  }),
  description:
    'The business\'s Meta commerce accounts and shops (a shop on Facebook and Instagram, e.g. made by Shopify\'s channel), '
    + 'read LIVE — only the chosen Facebook Page\'s and the chosen ad account\'s business portfolio\'s (the portfolio\'s only '
    + 'when no other business in Nexus uses it; an account or Page another business uses is its id only). view accounts: '
    + 'the commerce accounts and their status. account (commerceAccountId; country, locale): name, status, contact, terms, '
    + 'the Page, channels, payment provider, offsite checkout countries; checkout, call to action and shop ads set-up per '
    + 'country; privacy policy per language. shops: its shops with the Facebook and Instagram sales channel and their '
    + 'status (only channels set up appear). shop (shopId). setup-status: the shop set-up status of the chosen Page (or of '
    + 'a commerce account). checkout-countries (countries): where Shop checkout sends buyers to the website, and the '
    + 'checkout set-up per country. Several fields are in Meta\'s SDK only: when Meta refuses one, the answer names it. '
    + 'Meta cannot change these settings by API for a seller (Commerce Manager); a shop\'s catalogs: meta-catalogs view '
    + 'shop-catalogs. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveCommerce({
      connectionId: str(args.connectionId),
      view: args.view as CommerceInput['view'],
      commerceAccountId: str(args.commerceAccountId),
      shopId: str(args.shopId),
      country: str(args.country),
      countries: (args.countries as string[] | undefined) ?? null,
      locale: str(args.locale),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-instagram-product-tags ──────────────────────────────────────────────────────────────────────────────────

const metaInstagramProductTags: AgentTool = {
  name: 'meta-instagram-product-tags',
  title: 'Instagram product tags',
  ...READ_ONLY,
  requires: [F.adsView],
  restrictedFields: META_CATALOG_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(IG_TAG_VIEWS)).describe(IG_TAG_VIEWS.join(' | ')),
    catalogId: catalogArg('search: the catalog (default the one the account tags from); appeal: optional, checked'),
    search: z.string().trim().min(1).max(100).optional().describe('search: a product name or SKU (default: every tag-eligible product)'),
    mediaId: metaIdArg('tags: the chosen Instagram account\'s post (from meta-instagram-media view media)'),
    slides: z.boolean().optional().describe('tags: also the tags on each carousel slide (at most 10)'),
    itemId: metaIdArg('appeal: the product (Meta\'s product id = its catalog item id, from view search or meta-catalog-items)'),
    maxRows: maxRowsArg(50),
    connectionId: connectionArg,
  }),
  description:
    'Instagram product tags of the business\'s chosen Instagram account, read LIVE (only that account and its own posts). '
    + 'view eligibility: may it tag products (an approved Instagram Shop), its shopping review status, and Meta\'s limits. '
    + 'catalogs: the catalogs it may tag from (a catalog Nexus may not read is not shown). search (search, catalogId): '
    + 'tag-eligible products by name or SKU with their review status — only approved products show on a post. tags '
    + '(mediaId, slides): the tags on a post with their place, review status and price. appeal (itemId): the appeal '
    + 'state of a product rejected for tagging. Prices are Meta\'s text under restricted keys (priceCents only when the '
    + 'text names an ISO currency). Meta cannot: tag Stories or Live, tag for Creator accounts, or remove a tag by API '
    + '(Instagram app only). Adding tags and appealing are change tools (a later Nexus step). Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveInstagramProductTags({
      connectionId: str(args.connectionId),
      view: args.view as InstagramTagsInput['view'],
      catalogId: str(args.catalogId),
      search: str(args.search),
      mediaId: str(args.mediaId),
      slides: args.slides === true,
      itemId: str(args.itemId),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

export const META_ADS_COMMERCE_TOOLS: AgentTool[] = [metaProductSets, metaCommerce, metaInstagramProductTags]
