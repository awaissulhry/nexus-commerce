/**
 * Google Ads programme 2, G12 (2026-10-16, Owner's brief "no gap at all") — Merchant Center, through the Merchant API v1:
 *
 *   google-merchant-live              read LIVE: the account (its issues and product counts per destination and country),
 *                                     products with their status and issues, one product in full (with what Nexus wrote
 *                                     for it), data sources (rules, inputs, the last fetch; which ones Nexus made),
 *                                     promotions, a product's local and regional inventory, product performance
 *   set-google-merchant-products      a product's input in a supplemental data source Nexus made: set attributes (or fill
 *                                     them from Nexus's own product), take some out, or delete the input
 *   set-google-merchant-data-sources  make a supplemental or a promotion data source, rename or delete (when empty) one
 *                                     Nexus made
 *   set-google-merchant-promotions    make, change or end a promotion in a promotion data source Nexus made
 *
 * Every change is a Nexus change: a preview, an approvalId, a person approves it in Nexus, it runs as that person, never by
 * rule (google-merchant-kit.ts). Google cannot check a Merchant change first (no validate_only). Only the Merchant Center
 * account this business chose in Nexus; Nexus never edits or deletes the primary feed that Shopify's Google channel owns.
 *
 * Not offered, on purpose (said in the descriptions): a primary data source and any change of one (its products, rules,
 * countries); price, sale price, availability and link of a product (they must match the shop: Nexus prices and stock reach
 * Shopify, and its Google feed, from Nexus); local and regional inventory writes (Nexus has no store whose Merchant Center
 * store code it knows — StockLocation types are warehouses, FBA, channel-reserved and Shopify locations; a store code comes
 * from a Google Business Profile, which needs the business.manage sign-in Nexus does not have); deleting a promotion (the
 * Merchant API has none: a promotion is ended).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import {
  MERCHANT_CHANGE_RULES, merchantAccountArg, merchantCenterIdArg, merchantChangePreview, merchantIdArg, merchantRecordAccount, merchantWhyArg,
  runMerchantChange, type MerchantDraftBuilder,
} from './google-merchant-kit.js'
import {
  COUNTRY_RE, FEED_LABEL_RE, LANGUAGE_RE, MERCHANT_PRODUCT_ATTRIBUTES, PROMOTION_DESTINATIONS, PROMOTION_ID_RE, COUPON_VALUE_TYPES,
  type MerchantAttributeSpec,
} from '../../gateway/google-merchant-calls.js'
import { MerchantError, merchantAccount, resolveRunTime, type MerchantAccount } from '../../marketing/google-merchant/client.js'
import {
  liveAccountIssues, liveAggregateStatuses, liveDataSources, liveFileUpload, liveInventory, livePerformance, liveProduct, liveProducts,
  livePromotions, MAX_PRODUCTS, productKey, productRowOf, productVerdict, type MerchantProductRow,
} from '../../marketing/google-merchant/live.js'
import { nexusDataSourceIds, recordedCount, recordedInput, recordedPromotion, DATA_SOURCES_TOOL, PRODUCTS_TOOL, PROMOTIONS_TOOL } from '../../marketing/google-merchant/records.js'
import { FROM_NEXUS_FIELDS, plainText, productDraft, productUndoArgs, type FromNexusField, type ProductRequest } from '../../marketing/google-merchant/change-products.js'
import { DATA_SOURCE_ACTIONS, dataSourceDraft, type DataSourceRequest } from '../../marketing/google-merchant/change-data-sources.js'
import { PROMOTION_FIELDS, promotionDraft, promotionUndoArgs, type PromotionRequest, type PromotionState } from '../../marketing/google-merchant/change-promotions.js'
import { nexusProductsBySku } from '../../marketing/google-ads/read-detail.service.js'
import prisma from '../../../db.js'

type Json = Record<string, any>
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)

const common = {
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

const offerIdArg = z.string().trim().min(1).max(50).describe('the product\'s offer id in Merchant Center (its item id; for products Shopify\'s Google channel sends, as Merchant Center shows it)')
const languageArg = z.preprocess(lower, z.string().regex(LANGUAGE_RE, 'a two-letter language code')).describe('the product\'s content language, two letters (it, en, de …)')
const feedLabelArg = z.preprocess(upper, z.string().regex(FEED_LABEL_RE, 'a feed label: 1 to 20 of A-Z, 0-9, - and _')).describe('the product\'s feed label (often the country: IT, DE …; google-merchant-live shows it)')
const countryArg = z.preprocess(upper, z.string().regex(COUNTRY_RE, 'a two-letter country code'))
const accountIdOf = (record: unknown): Record<string, string> => {
  const r = (record ?? {}) as { accountId?: unknown; merchantCenterId?: unknown }
  return { ...(typeof r.accountId === 'string' ? { accountId: r.accountId } : {}), ...(typeof r.merchantCenterId === 'string' ? { merchantCenterId: r.merchantCenterId } : {}) }
}

/** A Nexus product per offer id (its SKU), for the reads. */
async function nexusOf(offerIds: string[]): Promise<Map<string, { productId: string; sku: string; name: string } | null>> {
  try { return await nexusProductsBySku(offerIds) } catch { return new Map() }
}

// ── google-merchant-live ──────────────────────────────────────────────────────────────────────────────────────────

export const MERCHANT_LIVE_VIEWS = ['overview', 'products', 'product', 'data-sources', 'promotions', 'inventory', 'performance'] as const
type View = typeof MERCHANT_LIVE_VIEWS[number]
const STATUS_FILTERS = ['all', 'disapproved', 'pending', 'approved', 'issues'] as const

const accountOut = (a: MerchantAccount) => ({ merchantCenterId: a.merchantCenterId, name: a.name, accountId: a.accountId })
const day = (d: Date) => d.toISOString().slice(0, 10)

async function productsView(account: MerchantAccount, args: Json): Promise<Json> {
  const { rows, more } = await liveProducts(account)
  const counts = { approved: 0, pending: 0, disapproved: 0, none: 0 }
  for (const row of rows) counts[productVerdict(row)] += 1
  const status = (args.status ?? 'all') as typeof STATUS_FILTERS[number]
  const search = typeof args.search === 'string' ? args.search.toLowerCase() : null
  const context = typeof args.context === 'string' ? args.context : null
  const country = typeof args.country === 'string' ? args.country : null
  const keep = (row: MerchantProductRow) => {
    if (status === 'issues' ? !row.issues.length : status !== 'all' && productVerdict(row) !== status) return false
    if (search && !row.offerId.toLowerCase().includes(search) && !(row.title ?? '').toLowerCase().includes(search)) return false
    if (context && !row.status.some((s) => s.context === context) && !row.issues.some((i) => i.context === context)) return false
    if (country && !row.status.some((s) => [...s.approved, ...s.pending, ...s.disapproved].includes(country))) return false
    return true
  }
  const matching = rows.filter(keep)
  const limit = Number(args.limit ?? 50)
  const shown = matching.slice(0, limit)
  const nexus = await nexusOf(shown.map((r) => r.offerId))
  return {
    read: rows.length, ...(more ? { note: `Merchant Center has more than ${MAX_PRODUCTS} products: the first ${MAX_PRODUCTS} were read.` } : {}),
    counts, matching: matching.length, shown: shown.length,
    products: shown.map((r) => ({ ...r, verdict: productVerdict(r), nexus: nexus.get(r.offerId) ?? null })),
  }
}

const KEPT_ATTRIBUTES = [
  'title', 'description', 'link', 'mobileLink', 'imageLink', 'additionalImageLinks', 'price', 'salePrice', 'salePriceEffectiveDate', 'availability',
  'brand', 'gtins', 'mpn', 'identifierExists', 'googleProductCategory', 'productTypes', 'customLabel0', 'customLabel1', 'customLabel2', 'customLabel3',
  'customLabel4', 'color', 'size', 'sizeSystem', 'sizeTypes', 'gender', 'ageGroup', 'material', 'pattern', 'condition', 'itemGroupId',
  'productHighlights', 'pause', 'excludedDestinations', 'includedDestinations', 'shoppingAdsExcludedCountries', 'shippingLabel', 'returnPolicyLabel',
]

async function productView(account: MerchantAccount, args: Json): Promise<ToolResult> {
  if (!args.offerId || !args.contentLanguage || !args.feedLabel) return { ok: false, error: 'view product needs offerId, contentLanguage and feedLabel (view products lists them).' }
  const key = productKey(args.contentLanguage, args.feedLabel, args.offerId)
  const raw = await liveProduct(account, key)
  if (!raw) return { ok: false, error: `Merchant Center has no product ${args.offerId} in language ${args.contentLanguage} with feed label ${args.feedLabel}.` }
  const row = productRowOf(raw)
  const a = (raw.productAttributes ?? {}) as Json
  const attributes: Json = {}
  for (const name of KEPT_ATTRIBUTES) {
    if (a[name] === undefined) continue
    attributes[name] = name === 'description' && typeof a[name] === 'string' && a[name].length > 1000 ? `${a[name].slice(0, 1000)}…` : a[name]
  }
  const made = [...await nexusDataSourceIds(account.merchantCenterId)]
  const inputs = (await Promise.all(made.map(async (id) => ({ dataSourceId: id, record: await recordedInput(account.merchantCenterId, id, key) }))))
    .filter((x) => x.record).map((x) => ({ dataSourceId: x.dataSourceId, state: x.record!.state, at: x.record!.at }))
  const nexus = await nexusOf([args.offerId])
  return {
    ok: true,
    data: {
      account: accountOut(account), product: row ? { ...row, verdict: productVerdict(row) } : null, attributes,
      customAttributes: Array.isArray(raw.customAttributes) ? raw.customAttributes.length : 0,
      nexusInputs: inputs, nexus: nexus.get(args.offerId) ?? null,
    },
  }
}

async function dataSourcesView(account: MerchantAccount, args: Json): Promise<Json> {
  const [sources, made] = await Promise.all([liveDataSources(account), nexusDataSourceIds(account.merchantCenterId)])
  const one = typeof args.dataSourceId === 'string' ? sources.find((d) => d.dataSourceId === args.dataSourceId) : null
  if (args.dataSourceId && !one) return { error: `Merchant Center has no data source ${args.dataSourceId}.` }
  const list = (one ? [one] : sources).map((d) => ({ ...d, madeByNexus: made.has(d.dataSourceId) }))
  const lastFetch = one && one.input === 'FILE' ? await liveFileUpload(account, one.dataSourceId) : undefined
  return {
    dataSources: list,
    ...(lastFetch !== undefined ? { lastFetch } : {}),
    note: 'Nexus writes products and promotions only into the data sources it made (madeByNexus), never into a primary feed. A supplemental '
      + 'data source reaches a product only when its primary data source links it (defaultRule; the first source listed wins an attribute).',
  }
}

async function liveView(args: Json): Promise<ToolResult> {
  const account = await merchantAccount({ accountId: args.accountId ?? null, merchantCenterId: args.merchantCenterId ?? null })
  if ('refusal' in account) return { ok: false, error: account.refusal }
  const view = args.view as View
  try {
    switch (view) {
      case 'overview': {
        const [issues, aggregates, sources, made] = await Promise.all([
          liveAccountIssues(account), liveAggregateStatuses(account), liveDataSources(account), nexusDataSourceIds(account.merchantCenterId),
        ])
        return {
          ok: true,
          data: {
            account: accountOut(account), accountIssues: issues, products: aggregates,
            dataSources: sources.map((d) => ({ dataSourceId: d.dataSourceId, displayName: d.displayName, type: d.type, input: d.input, madeByNexus: made.has(d.dataSourceId) })),
          },
        }
      }
      case 'products': return { ok: true, data: { account: accountOut(account), ...(await productsView(account, args)) } }
      case 'product': return await productView(account, args)
      case 'data-sources': {
        const out = await dataSourcesView(account, args)
        return out.error ? { ok: false, error: out.error } : { ok: true, data: { account: accountOut(account), ...out } }
      }
      case 'promotions': {
        const [promotions, made] = await Promise.all([livePromotions(account), nexusDataSourceIds(account.merchantCenterId)])
        return { ok: true, data: { account: accountOut(account), promotions: promotions.map((p) => ({ ...p, inNexusDataSource: !!p.dataSourceId && made.has(p.dataSourceId) })) } }
      }
      case 'inventory': {
        if (!args.offerId || !args.contentLanguage || !args.feedLabel) return { ok: false, error: 'view inventory needs offerId, contentLanguage and feedLabel.' }
        const inventory = await liveInventory(account, productKey(args.contentLanguage, args.feedLabel, args.offerId))
        return { ok: true, data: { account: accountOut(account), offerId: args.offerId, ...inventory, note: 'Read only: Nexus has no store whose Merchant Center store code it knows, so it does not write local or regional inventory.' } }
      }
      case 'performance': {
        const to = typeof args.to === 'string' ? args.to : day(new Date(Date.now() - 86_400_000))
        const from = typeof args.from === 'string' ? args.from : day(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000))
        if (from > to) return { ok: false, error: 'from is after to.' }
        const rows = await livePerformance(account, from, to, Number(args.limit ?? 50))
        const nexus = await nexusOf(rows.map((r) => r.offerId ?? '').filter(Boolean))
        return {
          ok: true,
          data: {
            account: accountOut(account), from, to, rows: rows.map((r) => ({ ...r, nexus: r.offerId ? nexus.get(r.offerId) ?? null : null })),
            note: 'Days are in Merchant Center\'s time zone. Clicks and impressions per product, split ORGANIC (free listings) and ADS; for spend and sales of the ads use google-ads-numbers.',
          },
        }
      }
    }
  } catch (err) {
    if (err instanceof MerchantError) return { ok: false, error: `Nexus could not read Merchant Center: ${err.message}` }
    throw err
  }
  return { ok: false, error: `Unknown view ${String(view)}.` }
}

const googleMerchantLive: AgentTool = {
  name: 'google-merchant-live',
  title: 'Merchant Center, live from Google',
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  // It reads Google live (no change): Claude is told it reaches outside Nexus.
  openWorld: true,
  requires: [F.listingsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(MERCHANT_LIVE_VIEWS)).describe('what to read: overview | products | product | data-sources | promotions | inventory | performance'),
    accountId: merchantAccountArg,
    merchantCenterId: merchantCenterIdArg,
    offerId: offerIdArg.optional(),
    contentLanguage: languageArg.optional(),
    feedLabel: feedLabelArg.optional(),
    status: z.preprocess(lower, z.enum(STATUS_FILTERS)).optional().describe('view products: all (default), disapproved, pending, approved, or issues (any issue)'),
    context: z.preprocess(upper, z.string().regex(/^[A-Z_]{3,40}$/)).optional().describe('view products: one destination (reporting context), e.g. SHOPPING_ADS or FREE_LISTINGS'),
    country: countryArg.optional().describe('view products: one country (two letters) the product is approved, pending or disapproved in'),
    search: z.string().trim().min(1).max(80).optional().describe('view products: a part of the offer id or title'),
    dataSourceId: merchantIdArg('view data-sources: one data source, with its last fetch when it is a file').optional(),
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('view performance: the first day (YYYY-MM-DD; default 30 days back)'),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('view performance: the last day (YYYY-MM-DD; default yesterday)'),
    limit: z.coerce.number().int().min(1).max(250).optional().describe('views products and performance: at most this many rows (default 50)'),
  }),
  description:
    'Merchant Center, read LIVE from Google now (the Merchant Center account this business chose in Nexus; ids never cross businesses). '
    + 'view overview: the account\'s issues (title, severity, where) and product counts per destination and country (active, pending, '
    + 'disapproved, expiring) with the top issues, and the data sources (which Nexus made). products: up to 1000 products with their '
    + 'status per destination (Shopping ads, free listings …) and country, their issues (code, severity, attribute, how to fix) and the '
    + 'Nexus product with that SKU; filter by status, destination, country or a word. product (offerId + contentLanguage + feedLabel): '
    + 'one product in full — attributes, status, issues, its primary data source, and what Nexus wrote for it in its own supplemental '
    + 'data sources. data-sources: every data source — primary, supplemental, promotion, inventory — with its input (API, file, UI), '
    + 'feed label, language, countries, destinations, the default rule (which source wins an attribute), what links a supplemental '
    + 'source, the fetch schedule, and which ones Nexus made (dataSourceId: one, with its last fetch and its issues). promotions: '
    + 'promotions with their offer, dates, status per destination and issues. inventory (offerId + contentLanguage + feedLabel): local '
    + 'store and regional prices and availability of one product. performance (from, to): clicks, impressions and CTR per product, '
    + 'organic (free listings) and ads, most clicks first. Read only; the changes are set-google-merchant-products, '
    + 'set-google-merchant-data-sources and set-google-merchant-promotions.',
  handler: (args) => liveView(args),
}

// ── set-google-merchant-products ──────────────────────────────────────────────────────────────────────────────────

function attributeSchema(spec: MerchantAttributeSpec): z.ZodTypeAny {
  switch (spec.kind) {
    case 'text': return z.string().trim().min(1).max(spec.max)
    case 'texts': return z.array(z.string().trim().min(1).max(spec.max)).min(1).max(spec.items)
    case 'enum': return z.enum(spec.values as [string, ...string[]])
    case 'enums': return z.array(z.enum(spec.values as [string, ...string[]])).min(1).max(spec.items)
    case 'url': return z.string().trim().url().max(2000)
    case 'urls': return z.array(z.string().trim().url().max(2000)).min(1).max(spec.items)
    case 'bool': return z.boolean()
    case 'gtins': return z.array(z.string().trim().regex(/^\d{8,14}$/, 'a GTIN is 8 to 14 digits')).min(1).max(10)
    case 'countries': return z.array(z.string().trim().regex(COUNTRY_RE, 'a two-letter country code')).min(1).max(50)
  }
}

const ATTRIBUTE_NAMES = Object.keys(MERCHANT_PRODUCT_ATTRIBUTES) as [string, ...string[]]
const attributesArg = z.object(Object.fromEntries(Object.entries(MERCHANT_PRODUCT_ATTRIBUTES).map(([name, spec]) => [name, attributeSchema(spec).optional()]))).strict()

const productsRequest = (args: Json): ProductRequest => ({
  action: args.action, dataSourceId: args.dataSourceId, offerId: args.offerId, contentLanguage: args.contentLanguage, feedLabel: args.feedLabel,
  attributes: args.attributes, clear: args.clear, fromNexus: args.fromNexus,
})

/** What Nexus holds for the product whose SKU is the offer id (its master data), in Google's attribute names. */
async function nexusValues(offerId: string): Promise<{ sku: string; name: string; values: Partial<Record<FromNexusField, unknown>> } | null> {
  const hit = (await nexusOf([offerId])).get(offerId)
  if (!hit) return null
  const product = await prisma.product.findUnique({ where: { id: hit.productId }, select: { name: true, description: true, brand: true, gtin: true, ean: true, upc: true } })
  if (!product) return null
  const gtin = [product.gtin, product.ean, product.upc].map((v) => (v ?? '').replace(/\D/g, '')).find((v) => /^\d{8,14}$/.test(v))
  const description = product.description ? plainText(product.description).slice(0, 5000) : null
  return {
    sku: hit.sku, name: hit.name,
    values: { title: product.name ? product.name.slice(0, 150) : null, description, brand: product.brand ? product.brand.slice(0, 70) : null, gtins: gtin ? [gtin] : null },
  }
}

const buildProducts = (args: Json): MerchantDraftBuilder => async (account) => {
  const req = productsRequest(args)
  const key = productKey(req.contentLanguage, req.feedLabel, req.offerId)
  const [dataSources, nexusMade, recorded, raw] = await Promise.all([
    liveDataSources(account), nexusDataSourceIds(account.merchantCenterId), recordedInput(account.merchantCenterId, req.dataSourceId, key), liveProduct(account, key),
  ])
  const nexus = req.action === 'set' ? await nexusValues(req.offerId) : null
  return productDraft(req, {
    merchantCenterId: account.merchantCenterId, dataSources, nexusMade, recorded: recorded ? { state: recorded.state, at: recorded.at, outcome: recorded.outcome } : null,
    live: { exists: !!raw, dataSourceId: raw?.dataSource ? String(raw.dataSource).slice(String(raw.dataSource).lastIndexOf('/') + 1) : null, values: (raw?.productAttributes ?? {}) as Json },
    nexus,
  })
}

const productsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Json
    const account = await merchantRecordAccount(after)
    if (!account || typeof after.dataSourceId !== 'string' || typeof after.key !== 'string') return null
    const now = await recordedInput(account.merchantCenterId, after.dataSourceId, after.key)
    return { ...after, state: now?.state ?? null }
  },
  request(change: ToolChange) {
    const built = productUndoArgs((change.before ?? {}) as Json, (change.after ?? {}) as Json)
    if ('refusal' in built) return built
    return { tool: PRODUCTS_TOOL, args: { ...accountIdOf(change.after), ...built.args, why: 'undo of an earlier Merchant Center product change' } }
  },
}

const setGoogleMerchantProducts: AgentTool = {
  ...common,
  name: PRODUCTS_TOOL,
  title: 'Change a Merchant Center product',
  category: 'listings',
  // Partial: the Merchant API cannot read a product input back (productInputs has insert, patch and delete, no get), so
  // undo restores what Nexus recorded; after a change Merchant Center did not answer, the input may differ from it.
  reversibility: 'partial',
  // Ending a pause or an ads exclusion, or moving a product between product groups, can make the ads spend more.
  requires: [F.listingsEdit, F.listingsPublish, F.adsCampaignsManage],
  input: z.object({
    accountId: merchantAccountArg,
    merchantCenterId: merchantCenterIdArg,
    action: z.preprocess(lower, z.enum(['set', 'delete'])).describe('set (attributes, clear, fromNexus) or delete (this product\'s whole input in the data source)'),
    dataSourceId: merchantIdArg('a supplemental data source Nexus made (google-merchant-live view data-sources: madeByNexus)'),
    offerId: offerIdArg,
    contentLanguage: languageArg,
    feedLabel: feedLabelArg,
    attributes: attributesArg.optional().describe(
      'set: the attributes to set in this source (Google\'s names): title, description, brand, gtins, mpn, identifierExists, googleProductCategory, '
      + 'productTypes, customLabel0–4, color, size, sizeSystem, sizeTypes, gender, ageGroup, material, pattern, condition, productHighlights, '
      + 'imageLink, additionalImageLinks, excludedDestinations, includedDestinations, shoppingAdsExcludedCountries, pause (ADS or ALL), '
      + 'shippingLabel, returnPolicyLabel. Not price, sale price, availability or link (they must match the shop: change them in Nexus)'),
    clear: z.array(z.enum(ATTRIBUTE_NAMES)).min(1).max(30).optional().describe('set: attributes to take out of this source\'s input (the primary feed\'s value applies again)'),
    fromNexus: z.array(z.enum(FROM_NEXUS_FIELDS)).min(1).max(4).optional().describe('set: fill title, description, brand and/or gtins from the Nexus product whose SKU is the offer id (Nexus is the product master)'),
    why: merchantWhyArg,
  }),
  description:
    'A product\'s data in Merchant Center, through a SUPPLEMENTAL data source Nexus made for this business (set-google-merchant-data-sources): '
    + 'set attributes of one product (offerId + contentLanguage + feedLabel) — or fill title, description, brand and GTIN from the Nexus product with '
    + 'that SKU (fromNexus: Nexus is the product master) — take attributes out, or delete the product\'s whole input there. Nexus sends the '
    + 'whole input it last wrote with the change (the Merchant API cannot read an input back: Nexus keeps it in its own record), ONE product '
    + 'per change (several: a change plan). Never into the primary feed that Shopify\'s Google channel owns (nor any data source Nexus did '
    + 'not make): refused. Not price, sale price, availability or link: they must match the shop\'s page — change them in Nexus, from where '
    + 'they reach Shopify and its Google feed. The preview says from the live rules whether the values reach the product and whether the '
    + 'next Shopify feed fetch would overwrite them (a supplemental source reaches products only once a person links it to the primary '
    + 'data source in Merchant Center; Nexus never changes the primary\'s rules), warns when a value differs from Nexus\'s own, and marks '
    + 'SPENDS MONEY when the product can show in paid ads again (a pause or an ads exclusion ends, from Nexus\'s record and — when this '
    + 'source wins the rule — from the live product) or when a value product groups and inventory filters split by changes (custom '
    + 'labels, brand, product type, category, condition). Undo puts the input back as Nexus recorded it (a new one is deleted, a deleted '
    + 'one written again). When Merchant Center does not answer, the change is recorded as NOT CONFIRMED (outcome unknown) and the next '
    + 'change of that input says so and replaces it whole.' + MERCHANT_CHANGE_RULES,
  undo: productsUndo,
  handler: (args, ctx) => merchantChangePreview(args, ctx, buildProducts(args)),
  execute: (args, ctx) => runMerchantChange(args, ctx, buildProducts(args), args.action === 'delete' ? 'merchant.productInputs.delete' : 'merchant.productInputs.insert', (draft) => ({
    data: { action: args.action, offerId: args.offerId, dataSourceId: args.dataSourceId, attributes: Object.keys((draft.after.state ?? {}) as Json).length },
    before: draft.before,
    after: draft.after,
  }), { recordUnknown: true }),
}

// ── set-google-merchant-data-sources ──────────────────────────────────────────────────────────────────────────────

const dataSourcesRequest = (args: Json): DataSourceRequest => ({
  action: args.action, dataSourceId: args.dataSourceId, displayName: args.displayName, feedLabel: args.feedLabel, contentLanguage: args.contentLanguage,
  targetCountry: args.targetCountry, confirmDelete: args.confirmDelete,
})

const buildDataSources = (args: Json): MerchantDraftBuilder => async (account) => {
  const req = dataSourcesRequest(args)
  const [dataSources, nexusMade] = await Promise.all([liveDataSources(account), nexusDataSourceIds(account.merchantCenterId)])
  let held = 0
  let promotions = 0
  if (req.action === 'delete' && req.dataSourceId) {
    const source = dataSources.find((d) => d.dataSourceId === req.dataSourceId)
    if (source?.type === 'promotion') {
      held = await recordedCount(PROMOTIONS_TOOL, account.merchantCenterId, req.dataSourceId)
      promotions = (await livePromotions(account)).filter((p) => p.dataSourceId === req.dataSourceId).length
    } else held = await recordedCount(PRODUCTS_TOOL, account.merchantCenterId, req.dataSourceId)
  }
  return dataSourceDraft(req, { merchantCenterId: account.merchantCenterId, dataSources, nexusMade, held, livePromotions: promotions })
}

const dataSourcesUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Json
    const account = await merchantRecordAccount(after)
    if (!account) return null
    if (after.action !== 'rename' && !String(after.action).startsWith('create-')) return after
    const live = (await liveDataSources(account)).find((d) => d.dataSourceId === after.dataSourceId)
    return { ...after, displayName: live?.displayName ?? null }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Json
    const after = (change.after ?? {}) as Json
    const account = accountIdOf(after)
    switch (after.action) {
      case 'create-supplemental':
      case 'create-promotions':
        if (typeof after.dataSourceId !== 'string') return { refusal: 'This change does not record the id Google gave the new data source.' }
        return { tool: DATA_SOURCES_TOOL, args: { ...account, action: 'delete', dataSourceId: after.dataSourceId, confirmDelete: true, why: 'undo of a data source Nexus made (deleted only when empty)' } }
      case 'rename':
        if (typeof before.displayName !== 'string' || !before.displayName) return { refusal: 'The data source had no name to put back.' }
        return { tool: DATA_SOURCES_TOOL, args: { ...account, action: 'rename', dataSourceId: after.dataSourceId, displayName: before.displayName, why: 'undo of a data source rename' } }
      default:
        return { refusal: 'A deleted data source cannot come back: a new one gets a new id (make one with action create-supplemental or create-promotions).' }
    }
  },
}

const setGoogleMerchantDataSources: AgentTool = {
  ...common,
  name: DATA_SOURCES_TOOL,
  title: 'Change Merchant Center data sources',
  category: 'listings',
  reversibility: 'partial',
  requires: [F.listingsPublish, F.channelsSync],
  input: z.object({
    accountId: merchantAccountArg,
    merchantCenterId: merchantCenterIdArg,
    action: z.preprocess(lower, z.enum(DATA_SOURCE_ACTIONS)).describe(
      'create-supplemental (displayName; feedLabel + contentLanguage, or neither for any), create-promotions (displayName, targetCountry, '
      + 'contentLanguage), rename (dataSourceId of one Nexus made, displayName), delete (dataSourceId of an EMPTY one Nexus made, confirmDelete)'),
    dataSourceId: merchantIdArg('the data source (google-merchant-live view data-sources)').optional(),
    displayName: z.string().trim().min(1).max(200).optional().describe('create / rename: the name Merchant Center shows'),
    feedLabel: feedLabelArg.optional(),
    contentLanguage: languageArg.optional(),
    targetCountry: countryArg.optional().describe('create-promotions: the country its promotions are for (two letters)'),
    confirmDelete: z.boolean().optional().describe('delete: must be true (a deleted data source cannot come back)'),
    why: merchantWhyArg,
  }),
  description:
    'Data sources of the Merchant Center account this business chose (google-merchant-live view data-sources shows them): make a '
    + 'SUPPLEMENTAL product data source (API input; it adds attributes to the products a primary feed sends — set-google-merchant-products '
    + 'writes into it) or a PROMOTION data source (for set-google-merchant-promotions); rename or delete (only when empty, with confirmDelete) '
    + 'one Nexus made. Nexus never edits, fetches or deletes the primary feed that Shopify\'s Google channel owns, nor any other data source '
    + 'it did not make (the gateway refuses it too), and does not make a primary data source (a product there '
    + 'needs a price, availability and link that must match the shop, and a second primary would move products out of Shopify\'s feed). '
    + 'A new supplemental source reaches products only once a person links it to the primary data source in Merchant Center (Data '
    + 'sources › the primary › Rules): that changes the primary feed, so Nexus does not do it. Undo: a data source made is deleted (only '
    + 'when empty — a promotion data source that holds a promotion stays, as the Merchant API cannot delete a promotion), a rename is put '
    + 'back; a delete cannot be undone. Fetching a file data source now is not offered: Nexus makes API data sources only, and the Merchant '
    + 'API fetches only file ones.' + MERCHANT_CHANGE_RULES,
  undo: dataSourcesUndo,
  handler: (args, ctx) => merchantChangePreview(args, ctx, buildDataSources(args)),
  execute: (args, ctx) => runMerchantChange(args, ctx, buildDataSources(args), `merchant.dataSources.${String(args.action)}`, (draft, answer) => {
    const created = String(draft.after.action).startsWith('create-')
    const id = created ? (typeof answer.dataSourceId === 'string' ? answer.dataSourceId : typeof answer.name === 'string' ? answer.name.slice(answer.name.lastIndexOf('/') + 1) : null) : null
    const after = created ? { ...draft.after, created: !!id, dataSourceId: id } : draft.after
    return {
      data: { action: args.action, dataSourceId: after.dataSourceId ?? null, ...(created && !id ? { note: 'Google did not say the new data source\'s id: Nexus cannot treat it as its own. google-merchant-live view data-sources shows it.' } : {}) },
      before: draft.before,
      after,
    }
  }),
}

// ── set-google-merchant-promotions ────────────────────────────────────────────────────────────────────────────────

const ISO_TIME = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/, 'a date-time like 2026-11-01T00:00:00Z')
const promotionArgs = {
  title: z.string().trim().min(1).max(60).optional().describe('set: the promotion\'s title buyers see (up to 60 characters)'),
  type: z.preprocess(upper, z.enum(COUPON_VALUE_TYPES)).optional().describe('set: PERCENT_OFF (percentOff), MONEY_OFF (moneyOffCents + currency) or FREE_SHIPPING_STANDARD (needs a code)'),
  percentOff: z.coerce.number().int().min(1).max(99).nullable().optional().describe('PERCENT_OFF: the percent off, 1 to 99'),
  moneyOffCents: z.coerce.number().int().min(1).max(100_000_00).nullable().optional().describe('MONEY_OFF: the amount off, in cents of currency'),
  minimumPurchaseCents: z.coerce.number().int().min(1).max(100_000_00).nullable().optional().describe('the least a buyer spends for it, in cents of currency (null takes it out)'),
  currency: z.preprocess(upper, z.string().regex(/^[A-Z]{3}$/)).nullable().optional().describe('the currency of the amounts (ISO 4217, e.g. EUR)'),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/).nullable().optional().describe('the coupon code buyers type at checkout (up to 20 characters); null = no code'),
  products: z.preprocess(lower, z.enum(['all', 'specific'])).optional().describe('set: all products, or specific ones (itemIds, brands and/or productTypes)'),
  itemIds: z.array(z.string().trim().min(1).max(50)).min(1).max(250).nullable().optional().describe('specific: the offer ids it applies to'),
  excludedItemIds: z.array(z.string().trim().min(1).max(50)).min(1).max(250).nullable().optional().describe('specific: offer ids it does not apply to'),
  brands: z.array(z.string().trim().min(1).max(70)).min(1).max(50).nullable().optional().describe('specific: the brands it applies to'),
  productTypes: z.array(z.string().trim().min(1).max(750)).min(1).max(50).nullable().optional().describe('specific: the product types it applies to'),
  startsAt: ISO_TIME.optional().describe('set: when it starts (date-time with a time zone, e.g. 2026-11-01T00:00:00Z)'),
  endsAt: ISO_TIME.optional().describe('set: when it ends'),
  displayStartsAt: ISO_TIME.nullable().optional().describe('when Google starts showing it, if earlier than the start (with displayEndsAt)'),
  displayEndsAt: ISO_TIME.nullable().optional().describe('when Google stops showing it (with displayStartsAt)'),
  destinations: z.array(z.preprocess(upper, z.enum(PROMOTION_DESTINATIONS))).min(1).max(2).nullable().optional().describe('SHOPPING_ADS and/or FREE_LISTINGS (default both)'),
  url: z.string().trim().url().max(2000).nullable().optional().describe('the shop page that shows the promotion (https)'),
}

const promotionsRequest = (args: Json): PromotionRequest => ({
  action: args.action, dataSourceId: args.dataSourceId, promotionId: args.promotionId,
  fields: Object.fromEntries(PROMOTION_FIELDS.filter((f) => args[f] !== undefined).map((f) => [f, args[f]])),
})

const buildPromotions = (args: Json): MerchantDraftBuilder => async (account) => {
  const req = promotionsRequest(args)
  const [dataSources, nexusMade, promotions] = await Promise.all([liveDataSources(account), nexusDataSourceIds(account.merchantCenterId), livePromotions(account)])
  const source = dataSources.find((d) => d.dataSourceId === req.dataSourceId)
  const country = source?.countries[0] ?? ''
  const language = source?.contentLanguage ?? ''
  const live = promotions.find((p) => p.promotionId === req.promotionId && p.targetCountry === country && p.contentLanguage === language) ?? null
  const recorded = await recordedPromotion(account.merchantCenterId, req.dataSourceId, `${country}~${language}~${req.promotionId}`)
  return promotionDraft(req, {
    merchantCenterId: account.merchantCenterId, dataSources, nexusMade, live,
    recorded: recorded ? { state: recorded.state as PromotionState | null, at: recorded.at, outcome: recorded.outcome } : null, now: new Date(),
  })
}

const promotionsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Json
    const account = await merchantRecordAccount(after)
    if (!account || typeof after.dataSourceId !== 'string' || typeof after.key !== 'string') return null
    const now = await recordedPromotion(account.merchantCenterId, after.dataSourceId, after.key)
    return { ...after, state: now?.state ?? null }
  },
  request(change: ToolChange) {
    const built = promotionUndoArgs((change.before ?? {}) as Json, (change.after ?? {}) as Json)
    if ('refusal' in built) return built
    return { tool: PROMOTIONS_TOOL, args: { ...accountIdOf(change.after), ...built.args, why: 'undo of an earlier Merchant Center promotion change' } }
  },
}

const setGoogleMerchantPromotions: AgentTool = {
  ...common,
  name: PROMOTIONS_TOOL,
  title: 'Change a Merchant Center promotion',
  category: 'pricing',
  reversibility: 'partial',
  requires: [F.marketingCampaignsManage, F.pricingEdit],
  input: z.object({
    accountId: merchantAccountArg,
    merchantCenterId: merchantCenterIdArg,
    action: z.preprocess(lower, z.enum(['set', 'end'])).describe('set (make a promotion, or change the one Nexus wrote: the fields given) or end (it stops when this change runs)'),
    dataSourceId: merchantIdArg('a promotion data source Nexus made (its country and language are the promotion\'s)'),
    promotionId: z.string().trim().regex(PROMOTION_ID_RE, 'a promotion id: 1 to 50 of A-Z, a-z, 0-9, - and _').describe('the promotion\'s id (up to 50 characters; yours to choose for a new one)'),
    ...promotionArgs,
    why: merchantWhyArg,
  }),
  description:
    'Promotions on Google Shopping (ads and free listings) of the Merchant Center account this business chose, in a PROMOTION data source '
    + 'Nexus made (set-google-merchant-data-sources action create-promotions): make one (title, type and amount, all or specific products, '
    + 'start and end, an optional code and minimum purchase), change one Nexus made (only the fields given), or end one when this change '
    + 'runs (the Merchant API cannot delete a promotion). A promotion CHANGES THE PRICE BUYERS SEE: the preview says the offer, the '
    + 'products, the country and the dates as its money line (spendsMoney — the person\'s decision). Google reviews every promotion, and '
    + 'the shop must give the same offer at checkout: Nexus does not make the Shopify discount here. Only for accounts in the Promotions '
    + 'program. A free shipping promotion needs a code (Google\'s rule). Undo puts the promotion back as it was, or ends one it made.'
    + MERCHANT_CHANGE_RULES,
  undo: promotionsUndo,
  handler: (args, ctx) => merchantChangePreview(args, ctx, buildPromotions(args)),
  execute: (args, ctx) => runMerchantChange(args, ctx, buildPromotions(args), 'merchant.promotions.insert', (draft, _answer, sentAt) => ({
    data: { action: args.action, promotionId: args.promotionId, dataSourceId: args.dataSourceId },
    before: draft.before,
    // The record of a promotion ended "now" holds the times it was sent with, not the markers.
    after: resolveRunTime(draft.after, sentAt),
  }), { recordUnknown: true }),
}

export const GOOGLE_ADS_MERCHANT_TOOLS: AgentTool[] = [googleMerchantLive, setGoogleMerchantProducts, setGoogleMerchantDataSources, setGoogleMerchantPromotions]
