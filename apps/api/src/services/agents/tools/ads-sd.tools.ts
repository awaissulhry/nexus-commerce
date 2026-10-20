/**
 * SD-AUD (2026-10-20) — what Claude needs to target Amazon Sponsored Display, read LIVE from Amazon through the channel
 * gateway (services/advertising/sd/*.client.ts). Nothing is stored and nothing changes: each answer gives the ids a
 * target takes and the expression to send, so a create (add-ad-targets, create-ad-group, add-negative-targets) can use
 * them as they are.
 *
 *   sd-audiences                  Amazon's audiences (audienceSameAs ids): by words, top category, a taxonomy path or id;
 *                                 or, with browse, the taxonomy itself one level at a time (with audience counts)
 *   sd-categories                 Amazon's category ids (asinCategorySameAs) by words — contextual categories, or the
 *                                 categories of views / purchases remarketing — and one category's refinements (its
 *                                 brands, age ranges, genres: asinBrandSameAs and the other refinement ids)
 *   sd-targeting-recommendations  what Amazon suggests targeting for some ASINs (or an SD ad group's): products (also by
 *                                 contextual theme), categories and, for an audiences campaign, Amazon audiences
 *   sd-bid-recommendations        Amazon's bid range and recommended bid per targeting clause (an SD ad group's own
 *                                 targets, targets by id, or expressions), for its ASINs, cost type and bid optimization
 *
 * Order: arguments, then the market and its Ads profile (adsClientContextFor), then Amazon; nothing is asked before the
 * profile resolves. A server whose Amazon Ads mode is sandbox asks Amazon nothing and says so. Every refusal from Amazon
 * reaches the person in Amazon's own words (sd-read.ts sdReadFailure). Amazon pages are carried as a cursor bound to
 * this tool, the business, the market and the filters (`<check>.<nextToken>`), as aplus-content binds its pages.
 *
 * Money: a recommended bid and its range, and a target's current bid, are ad-spend money (restrictedFields).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { InvalidCursorError, cursorScope } from '../../../lib/pagination/cursor.js'
import { normalizeMarketplaceCode } from '../../../utils/marketplace-code.js'
import { adsMode, type ClientContext } from '../../advertising/ads-api-client.js'
import { adsClientContextFor } from '../../advertising/ads-profile-resolver.js'
import { sdCountryOf, sdLocaleOf, sdReadFailure } from '../../advertising/sd/sd-read.js'
import { searchSdAudiences, sdAudienceTaxonomy } from '../../advertising/sd/sd-audiences.client.js'
import { searchSdCategories, sdCategoryRefinements, type SdCategoryKind } from '../../advertising/sd/sd-categories.client.js'
import {
  sdBidRecommendations, sdTargetingRecommendations, type SdRecommendationType, type SdTactic, type SdThemeType,
} from '../../advertising/sd/sd-recommendations.client.js'
import type { SdExpressionJson } from '../../advertising/sd/sd-entities.client.js'
import { SD_MAX_CLAUSES, sdAdGroupForRead, sdTargetsForRead, type SdAdGroupForRead } from '../../advertising/sd/sd-lookup.service.js'
import { sdExpressionInWords } from '../../advertising/sd/sd-expression-words.js'
import { campaignCurrency } from './ads-tool-guards.js'
import { currencyOfMarket } from './ads-portfolio.tools.js'
import type { AgentTool, ToolResult } from '../tool-types.js'

const ADSPEND = FIELDS.financialsAdspendView
/** A bid Amazon recommends (and its range), and the bid a target holds now: ad-spend money. */
const BID_MONEY = { recommendedBidCents: ADSPEND, bidRangeLowCents: ADSPEND, bidRangeHighCents: ADSPEND, currentBidCents: ADSPEND } as const

const MAX_CURSOR = 2000
const CHECK_LENGTH = 22
const LIVE_NOTE = 'Read live from Amazon (nothing is stored in Nexus); a live read works only in the deployed API.'
const SANDBOX = 'This Nexus server runs Amazon Ads in sandbox mode: Amazon was not asked, so there is nothing to show. A live read works only in the deployed API.'

const MARKET = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'a market is a two-letter code (IT, DE, FR, ES, UK, …)')
const ASIN = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 letters and digits')
const NEXUS_ID = z.string().trim().min(1).max(64)
const limitArg = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback).describe(`how many to show (default ${fallback}, max ${max})`)
const cursorArg = z.string().min(1).max(MAX_CURSOR).optional()
  .describe('nextCursor from the previous answer, with the same arguments; omit it for the first page')

// ── Market, profile, cursor ─────────────────────────────────────────────────────────────────────────────────────────

type Resolved = { market: string; ctx: ClientContext } | { refused: string }

/** The market's Ads profile, or the sentence why nothing can be read. */
async function profileOf(market: string): Promise<Resolved> {
  const ctx = await adsClientContextFor(market)
  if (!ctx) return { refused: `No Amazon Ads account serves market ${market} in this business (business-overview lists the markets and accounts).` }
  if (adsMode() !== 'live') return { refused: SANDBOX }
  return { market, ctx }
}

const scopeOf = (tool: string, market: string, filters: Record<string, unknown>) =>
  cursorScope(tool, { business: workspaceIdForQuery(), market, ...filters })
const checkOf = (scope: string, token: string) => createHash('sha256').update(JSON.stringify([scope, token])).digest('base64url').slice(0, CHECK_LENGTH)
/** Amazon's next-page token as a cursor; null when it would not fit (the answer says so). */
function cursorOf(scope: string, token: string | null): string | null {
  if (!token) return null
  const cursor = `${checkOf(scope, token)}.${token}`
  return cursor.length <= MAX_CURSOR ? cursor : null
}
/** The token a cursor carries. Throws InvalidCursorError for a cursor of another call, or an altered one. */
function tokenOf(scope: string, cursor: string | undefined): string | undefined {
  if (!cursor) return undefined
  const dot = cursor.indexOf('.')
  const token = cursor.slice(dot + 1)
  if (dot !== CHECK_LENGTH || !token || cursor.slice(0, dot) !== checkOf(scope, token)) throw new InvalidCursorError()
  return token
}
const pageNote = (token: string | null, cursor: string | null) =>
  token && !cursor ? { note: 'Amazon has more, but its page token is too long for Nexus to pass on as a cursor: narrow the search.' } : {}

/** Run one live read; Amazon's refusal (and a cursor of another call) becomes the answer's sentence. */
async function live(tool: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${tool} was called wrongly — cursor: ${error.message}` }
    return { ok: false, error: sdReadFailure(error) }
  }
}

// ── The target expressions each answer offers ──────────────────────────────────────────────────────────────────────

const audienceTarget = (audienceId: string) => [{ type: 'audience', value: [{ type: 'audienceSameAs', value: audienceId }] }]
const categoryTarget = (categoryId: string) => [{ type: 'asinCategorySameAs', value: categoryId }]
const remarketingTarget = (categoryId: string) => [{ type: 'views', value: [{ type: 'asinCategorySameAs', value: categoryId }, { type: 'lookback', value: '30' }] }]
const productTarget = (asin: string) => [{ type: 'asinSameAs', value: asin }]

// ── sd-audiences ───────────────────────────────────────────────────────────────────────────────────────────────────

const AUDIENCE_CATEGORIES = ['In-market', 'Interest', 'Lifestyle', 'Life event'] as const

const sdAudiences: AgentTool = {
  name: 'sd-audiences',
  title: 'Sponsored Display audiences',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    market: MARKET.describe('the Amazon market whose audiences to read: IT, DE, FR, ES, UK, …'),
    words: z.string().trim().min(1).max(200).optional()
      .describe('words in the audience name (Amazon matches broadly); commas separate alternatives, e.g. "motorcycle, biker"'),
    category: z.enum(AUDIENCE_CATEGORIES).optional().describe('only audiences of this top category and everything under it'),
    categoryPath: z.array(z.string().trim().min(1).max(100)).max(10).optional()
      .describe('a path in Amazon\'s audience taxonomy, top first (e.g. ["In-market", "Sporting Goods"]): its audiences, or with browse its sub-categories'),
    audienceIds: z.array(z.string().trim().regex(/^\d+$/, 'an audience id is digits')).max(50).optional().describe('only these audiences, by Amazon\'s id'),
    browse: z.boolean().default(false).describe('true: list the taxonomy categories one level under categoryPath (the top when none) instead of audiences'),
    limit: limitArg(250, 25),
    cursor: cursorArg,
  }),
  description:
    'Amazon\'s audiences for Sponsored Display in one market, read live from Amazon (nothing is stored or changed). '
    + 'Search by words in the name, a top category (In-market, Interest, Lifestyle, Life event), a taxonomy path or '
    + 'audience ids; only audiences Amazon lets you target. Per audience: audienceId, name, description, category and '
    + 'sub-category, status, Amazon\'s forecast of daily reach when it gives one, and target.expression — the '
    + 'audienceSameAs expression an SD audience target takes as it is (tactic T00030). With browse: the taxonomy one level '
    + 'under categoryPath, each category with its audience count, to walk down to a path. ' + LIVE_NOTE
    + ' Returns { items, nextCursor }.',
  handler: (args) => live('sd-audiences', async () => {
    const a = args as { market: string; words?: string; category?: string; categoryPath?: string[]; audienceIds?: string[]; browse: boolean; limit: number; cursor?: string }
    if (!a.browse && !a.words && !a.category && !a.categoryPath?.length && !a.audienceIds?.length) {
      return { ok: false, error: 'Give words, a category, a categoryPath or audienceIds to search, or browse: true to walk Amazon\'s audience taxonomy.' }
    }
    const p = await profileOf(a.market)
    if ('refused' in p) return { ok: false, error: p.refused }
    const country = sdCountryOf(normalizeMarketplaceCode(p.market, p.market))
    const scope = scopeOf('sd-audiences', p.market, { words: a.words, category: a.category, categoryPath: a.categoryPath, audienceIds: a.audienceIds, browse: a.browse, limit: a.limit })
    const nextToken = tokenOf(scope, a.cursor)
    if (a.browse) {
      const t = await sdAudienceTaxonomy(p.ctx, { country, categoryPath: a.categoryPath ?? [], maxResults: a.limit, nextToken })
      const nextCursor = cursorOf(scope, t.nextToken)
      return {
        ok: true,
        data: {
          market: p.market, categoryPath: t.categoryPath,
          items: t.categories.map((c) => ({ category: c.category, path: [...t.categoryPath, c.category], audienceCount: c.audienceCount })),
          nextCursor, ...pageNote(t.nextToken, nextCursor),
          ...(t.categories.length ? {} : { empty: 'No category under this path: it is a leaf. Call again without browse and with this categoryPath for its audiences.' }),
        },
      }
    }
    const words = a.words?.split(',').map((w) => w.trim()).filter(Boolean)
    const r = await searchSdAudiences(p.ctx, { country, words, category: a.category, categoryPath: a.categoryPath, audienceIds: a.audienceIds, maxResults: a.limit, nextToken })
    const nextCursor = cursorOf(scope, r.nextToken)
    return {
      ok: true,
      data: {
        market: p.market,
        items: r.audiences.map((x) => ({ ...x, target: { expression: audienceTarget(x.audienceId), inWords: sdExpressionInWords(audienceTarget(x.audienceId), [{ type: 'audience', value: [{ type: 'audienceSameAs', value: x.name }] }]) } })),
        matchCount: r.matchCount,
        nextCursor, ...pageNote(r.nextToken, nextCursor),
        ...(r.audiences.length ? {} : { empty: 'Amazon has no targetable audience matching this search in this market.' }),
      },
    }
  }),
}

// ── sd-categories ──────────────────────────────────────────────────────────────────────────────────────────────────

const CATEGORY_KINDS: Record<'contextual' | 'remarketing' | 'both', SdCategoryKind[]> = {
  contextual: ['PRODUCT_CATEGORY'],
  remarketing: ['PRODUCT_CATEGORY_AUDIENCE'],
  both: ['PRODUCT_CATEGORY', 'PRODUCT_CATEGORY_AUDIENCE'],
}

const sdCategories: AgentTool = {
  name: 'sd-categories',
  title: 'Sponsored Display categories',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    market: MARKET.describe('the Amazon market whose categories to read: IT, DE, FR, ES, UK, …'),
    words: z.string().trim().min(1).max(200).optional().describe('what the category is about, in words (Amazon searches by meaning and corrects spelling); give this or categoryId'),
    kind: z.enum(['contextual', 'remarketing', 'both']).default('contextual')
      .describe('contextual (default): categories to show ads in (asinCategorySameAs); remarketing: the categories of views / purchases audiences; both'),
    categoryId: z.string().trim().regex(/^\d+$/, 'a category id is digits').optional()
      .describe('one category\'s refinements instead: the brands (asinBrandSameAs ids), age ranges and genres a category target can be narrowed by'),
    limit: limitArg(250, 25),
    cursor: cursorArg,
  }),
  description:
    'Amazon\'s category ids for Sponsored Display targets in one market, read live from Amazon (nothing is stored or '
    + 'changed). With words: the categories Amazon finds for them (contextual by default, or the categories of views / '
    + 'purchases remarketing), each with categoryId, Amazon\'s name, its path and target.expression — the '
    + 'asinCategorySameAs expression a category target takes (for remarketing: a views audience over the last 30 days; '
    + 'change the lookback to 7, 14, 30, 60 or 90 for views, up to 365 for purchases). With categoryId: its refinements — '
    + 'brands (each id is the asinBrandSameAs value, for a refined category target or a negative brand target), age '
    + 'ranges and genres — read from Amazon\'s refinement list, which Sponsored Products shares with Display. ' + LIVE_NOTE
    + ' Returns { items, nextCursor } or { refinements }.',
  handler: (args) => live('sd-categories', async () => {
    const a = args as { market: string; words?: string; kind: 'contextual' | 'remarketing' | 'both'; categoryId?: string; limit: number; cursor?: string }
    if (!a.words && !a.categoryId) return { ok: false, error: 'Give words to search categories, or a categoryId for its refinements (brands, age ranges, genres).' }
    const p = await profileOf(a.market)
    if ('refused' in p) return { ok: false, error: p.refused }
    const locale = sdLocaleOf(normalizeMarketplaceCode(p.market, p.market))
    if (a.categoryId) {
      const r = await sdCategoryRefinements(p.ctx, a.categoryId, locale)
      const shown = <T,>(list: T[]) => list.slice(0, a.limit)
      return {
        ok: true,
        data: {
          market: p.market, categoryId: a.categoryId,
          refinements: {
            brands: shown(r.brands).map((b) => ({ ...b, refinement: { type: 'asinBrandSameAs', value: b.id } })),
            ageRanges: shown(r.ageRanges).map((x) => ({ ...x, refinement: { type: 'asinAgeRangeSameAs', value: x.id } })),
            genres: shown(r.genres).map((x) => ({ ...x, refinement: { type: 'asinGenreSameAs', value: x.id } })),
          },
          totals: { brands: r.brands.length, ageRanges: r.ageRanges.length, genres: r.genres.length },
          howToUse: 'Add a refinement after the category in the same expression: [{ type: "asinCategorySameAs", value: categoryId }, refinement, …] (one brand per expression).',
        },
      }
    }
    const scope = scopeOf('sd-categories', p.market, { words: a.words, kind: a.kind, limit: a.limit })
    const r = await searchSdCategories(p.ctx, { words: a.words as string, kinds: CATEGORY_KINDS[a.kind], locale, maxResults: a.limit, nextToken: tokenOf(scope, a.cursor) })
    const nextCursor = cursorOf(scope, r.nextToken)
    return {
      ok: true,
      data: {
        market: p.market,
        items: r.categories.map((c) => {
          const expression = c.kind === 'PRODUCT_CATEGORY' ? categoryTarget(c.categoryId) : remarketingTarget(c.categoryId)
          return {
            categoryId: c.categoryId, name: c.name, path: c.path, kind: c.kind === 'PRODUCT_CATEGORY' ? 'contextual' : 'remarketing', childCount: c.childCount,
            target: { expression, inWords: sdExpressionInWords(expression, c.kind === 'PRODUCT_CATEGORY' ? [{ type: 'asinCategorySameAs', value: c.name }] : null) },
          }
        }),
        total: r.total,
        nextCursor, ...pageNote(r.nextToken, nextCursor),
        ...(r.categories.length ? {} : { empty: 'Amazon found no category for these words in this market.' }),
      },
    }
  }),
}

// ── The ad group or ASINs a recommendation is for ──────────────────────────────────────────────────────────────────

type Basis = { market: string; asins: string[]; group: SdAdGroupForRead | null } | { refused: string }

async function basisOf(a: { market?: string; adGroupId?: string; asins?: string[] }): Promise<Basis> {
  let group: SdAdGroupForRead | null = null
  if (a.adGroupId) {
    group = await sdAdGroupForRead(a.adGroupId)
    if (!group) return { refused: `Ad group ${a.adGroupId} is not a Sponsored Display ad group of this business (ad-groups lists them).` }
  }
  const market = a.market ?? (group?.campaign.market ? normalizeMarketplaceCode(group.campaign.market, group.campaign.market) : null)
  if (!market) return { refused: 'Name the market, or an SD ad group (adGroupId) whose campaign names it.' }
  if (group?.campaign.market && normalizeMarketplaceCode(group.campaign.market, group.campaign.market) !== market) {
    return { refused: `Ad group ${group.name} is in market ${group.campaign.market}, not ${market}.` }
  }
  const asins = a.asins?.length ? [...new Set(a.asins)] : group?.asins ?? []
  if (!asins.length) {
    return { refused: group ? `Ad group ${group.name} advertises no product whose ASIN Nexus holds: give asins.` : 'Give the advertised ASINs (asins), or an SD ad group (adGroupId) whose products to use.' }
  }
  return { market, asins, group }
}

// ── sd-targeting-recommendations ───────────────────────────────────────────────────────────────────────────────────

/** Which recommendation types Amazon serves per tactic (SDRecommendationTypeV33). */
const TYPES_OF: Record<SdTactic, readonly SdRecommendationType[]> = { T00020: ['PRODUCT', 'CATEGORY'], T00030: ['CATEGORY', 'AUDIENCE'] }
const THEME_TYPES = ['asinPriceGreaterThan', 'asinBrandSameAs', 'asinReviewRatingLessThan', 'asinGlanceViewsGreaterThan'] as const

const sdTargetingRecs: AgentTool = {
  name: 'sd-targeting-recommendations',
  title: 'SD targeting recommendations',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    adGroupId: NEXUS_ID.optional().describe('a Sponsored Display ad group (its Nexus id, from ad-groups): its market, tactic and advertised ASINs are used'),
    market: MARKET.optional().describe('the Amazon market (IT, DE, …); needed when no adGroupId is given'),
    asins: z.array(ASIN).min(1).max(50).optional().describe('the advertised ASINs to get recommendations for (default: the ad group\'s)'),
    tactic: z.enum(['T00020', 'T00030']).optional()
      .describe('T00020 contextual (products, categories) or T00030 audiences (categories, Amazon audiences); default the ad group campaign\'s, else T00020'),
    types: z.array(z.enum(['PRODUCT', 'CATEGORY', 'AUDIENCE'])).min(1).max(3).optional()
      .describe('which recommendations: PRODUCT and CATEGORY for T00020, CATEGORY and AUDIENCE for T00030 (default: both of the tactic)'),
    themes: z.array(z.object({
      name: z.string().trim().min(1).max(100).describe('a name for the theme (not "default"), echoed in the answer'),
      type: z.enum(THEME_TYPES).describe('asinPriceGreaterThan: pricier products; asinBrandSameAs: the same brand; asinReviewRatingLessThan: lower rated; asinGlanceViewsGreaterThan: more viewed'),
    })).max(5).optional().describe('contextual themes for PRODUCT recommendations (up to 5): Amazon then also answers per theme'),
    limit: limitArg(100, 25),
  }),
  description:
    'What Amazon suggests targeting with Sponsored Display for some ASINs (or an SD ad group\'s), read live from Amazon '
    + '(nothing is stored or changed; Amazon needs about a week for a new ASIN). Products (ASIN, rank, which advertised '
    + 'ASIN it fits; per contextual theme when themes are given), categories (categoryId, name in the market\'s language, '
    + 'path, how many ASINs, rank) and, for an audiences campaign (T00030), Amazon audiences (audienceId, name, category, '
    + 'rank). Each comes with target.expression — the expression an SD target takes as it is — and its words. Lower rank '
    + 'is a stronger suggestion. ' + LIVE_NOTE,
  handler: (args) => live('sd-targeting-recommendations', async () => {
    const a = args as { adGroupId?: string; market?: string; asins?: string[]; tactic?: SdTactic; types?: SdRecommendationType[]; themes?: Array<{ name: string; type: SdThemeType }>; limit: number }
    const b = await basisOf(a)
    if ('refused' in b) return { ok: false, error: b.refused }
    const tactic: SdTactic = a.tactic ?? (b.group?.campaign.tactic === 'T00030' ? 'T00030' : 'T00020')
    const types = a.types?.length ? [...new Set(a.types)] : [...TYPES_OF[tactic]]
    const wrong = types.filter((t) => !TYPES_OF[tactic].includes(t))
    if (wrong.length) return { ok: false, error: `Amazon gives ${wrong.join(' and ')} recommendations only for tactic ${tactic === 'T00020' ? 'T00030' : 'T00020'}; tactic ${tactic} takes ${TYPES_OF[tactic].join(' and ')}.` }
    if (a.themes?.length && !types.includes('PRODUCT')) return { ok: false, error: 'Themes refine PRODUCT recommendations: ask for PRODUCT (tactic T00020) with them.' }
    const p = await profileOf(b.market)
    if ('refused' in p) return { ok: false, error: p.refused }
    const r = await sdTargetingRecommendations(p.ctx, { tactic, asins: b.asins, types, themes: a.themes, locale: sdLocaleOf(normalizeMarketplaceCode(p.market, p.market)) })
    const product = (x: { asin: string; rank: number | null; advertisedAsins: string[] }) => ({ ...x, target: { expression: productTarget(x.asin), inWords: sdExpressionInWords(productTarget(x.asin)) } })
    const cut = <T,>(list: T[]) => list.slice(0, a.limit)
    return {
      ok: true,
      data: {
        market: p.market, tactic, types, asins: b.asins,
        ...(b.group ? { adGroup: { adGroupId: b.group.adGroupId, name: b.group.name, campaign: b.group.campaign.name } } : {}),
        products: cut(r.products).map(product),
        categories: cut(r.categories).map((c) => ({ ...c, target: { expression: categoryTarget(c.categoryId), inWords: sdExpressionInWords(categoryTarget(c.categoryId), [{ type: 'asinCategorySameAs', value: c.name }]) } })),
        audiences: cut(r.audiences).map((x) => ({ ...x, target: { expression: audienceTarget(x.audienceId), inWords: sdExpressionInWords(audienceTarget(x.audienceId), [{ type: 'audience', value: [{ type: 'audienceSameAs', value: x.name }] }]) } })),
        themes: r.themes.map((t) => ({ name: t.name, code: t.code, expression: t.expression, products: cut(t.products).map(product) })),
        totals: { products: r.products.length, categories: r.categories.length, audiences: r.audiences.length },
      },
    }
  }),
}

// ── sd-bid-recommendations ─────────────────────────────────────────────────────────────────────────────────────────

const PREDICATE = z.object({
  type: z.string().trim().min(1).max(64).describe('the predicate: exactProduct, similarProduct, relatedProduct, asinCategorySameAs, asinBrandSameAs, lookback, audienceSameAs, …'),
  value: z.union([z.string().trim().max(200), z.number()]).optional().describe('its value: a category, brand or audience id, a lookback in days; none for exactProduct / similarProduct / relatedProduct'),
})
const EXPRESSION = z.array(z.object({
  type: z.string().trim().min(1).max(64).describe('asinSameAs, asinCategorySameAs (and its refinements), similarProduct, or views / purchases / audience for a nested one'),
  value: z.union([z.string().trim().max(200), z.number(), z.array(PREDICATE).min(1).max(10)]).optional()
    .describe('an ASIN or id for a flat predicate; the list of predicates for views / purchases / audience'),
})).min(1).max(10)

/** Amazon's expression grammar takes string values. */
const asSent = (e: z.infer<typeof EXPRESSION>): SdExpressionJson =>
  e.map((p) => ({ type: p.type, ...(p.value === undefined ? {} : { value: Array.isArray(p.value) ? p.value.map((x) => ({ type: x.type, ...(x.value === undefined ? {} : { value: String(x.value) }) })) : String(p.value) }) }))

const BID_OPTIMIZATIONS: Record<'cpc' | 'vcpm', readonly string[]> = { cpc: ['clicks', 'conversions'], vcpm: ['reach'] }
const toCents = (units: number | null) => (units == null ? null : Math.round(units * 100))

const sdBidRecs: AgentTool = {
  name: 'sd-bid-recommendations',
  title: 'SD bid recommendations',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: BID_MONEY,
  input: z.object({
    adGroupId: NEXUS_ID.optional().describe('a Sponsored Display ad group (its Nexus id, from ad-groups): its market, ASINs, cost type, bid optimization, creative type and — when no targets are given — its own targets are used'),
    market: MARKET.optional().describe('the Amazon market (IT, DE, …); needed when no adGroupId is given'),
    asins: z.array(ASIN).min(1).max(50).optional().describe('the advertised ASINs (default: the ad group\'s)'),
    targetIds: z.array(NEXUS_ID).min(1).max(SD_MAX_CLAUSES).optional().describe('SD targets by their Nexus id (targetId in ad-targets): their stored expressions are asked about'),
    expressions: z.array(EXPRESSION).min(1).max(SD_MAX_CLAUSES).optional()
      .describe('targeting expressions as an SD target takes them (e.g. [{ type: "views", value: [{ type: "exactProduct" }, { type: "lookback", value: "30" }] }])'),
    costType: z.enum(['cpc', 'vcpm']).optional().describe('cpc (per click) or vcpm (per 1,000 viewable impressions); default the ad group campaign\'s, else cpc'),
    bidOptimization: z.enum(['clicks', 'conversions', 'reach']).optional().describe('clicks or conversions with cpc, reach with vcpm; default the ad group\'s, else clicks (cpc) or reach (vcpm)'),
    creativeType: z.enum(['IMAGE', 'VIDEO']).optional().describe('the creative the bids are for; default the ad group\'s, else IMAGE'),
  }),
  description:
    'Amazon\'s bid recommendation per Sponsored Display targeting clause, read live from Amazon (nothing is stored or '
    + 'changed): for an SD ad group\'s own targets (up to 100), targets by id, or expressions you give, for the advertised '
    + 'ASINs, cost type, bid optimization and creative type. Per clause: its words, the recommended bid and Amazon\'s range '
    + '(recommendedBidCents, bidRangeLowCents, bidRangeHighCents — minor units of the market\'s currency, never converted; '
    + 'from the last 7 days of winning bids), the target\'s current bid when it is one of Nexus\'s, or Amazon\'s own code '
    + 'and words when it gives no bid for it (refinements do not change Amazon\'s recommendation). A bid is changed '
    + 'separately with set-target-bid. A person without the ad-spend money permission gets the same answer without the '
    + 'amounts. ' + LIVE_NOTE,
  handler: (args) => live('sd-bid-recommendations', async () => {
    const a = args as {
      adGroupId?: string; market?: string; asins?: string[]; targetIds?: string[]; expressions?: Array<z.infer<typeof EXPRESSION>>
      costType?: 'cpc' | 'vcpm'; bidOptimization?: 'clicks' | 'conversions' | 'reach'; creativeType?: 'IMAGE' | 'VIDEO'
    }
    // The clauses: targets by id and expressions as given, or else the ad group's own targets.
    type Clause = { targetId: string | null; expression: SdExpressionJson; resolved: unknown; currentBidCents: number | null }
    const clauses: Clause[] = []
    const notRead: string[] = []
    let market = a.market
    if (a.targetIds?.length) {
      const found = await sdTargetsForRead(a.targetIds)
      const missing = a.targetIds.filter((id) => !found.some((t) => t.targetId === id))
      if (missing.length) return { ok: false, error: `Not Sponsored Display targets of this business: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''} (ad-targets lists them).` }
      const markets = [...new Set(found.map((t) => normalizeMarketplaceCode(t.market ?? '', t.market ?? '')))]
      if (markets.length > 1) return { ok: false, error: `These targets are in several markets (${markets.join(', ')}): ask per market.` }
      if (market && markets[0] && markets[0] !== market) return { ok: false, error: `These targets are in market ${markets[0]}, not ${market}.` }
      market ??= markets[0] || undefined
      for (const t of found) {
        if (Array.isArray(t.expression) && t.expression.length) clauses.push({ targetId: t.targetId, expression: t.expression as SdExpressionJson, resolved: t.resolvedExpression, currentBidCents: t.bidCents })
        else notRead.push(t.targetId)
      }
    }
    for (const e of a.expressions ?? []) clauses.push({ targetId: null, expression: asSent(e), resolved: null, currentBidCents: null })
    const b = await basisOf({ market, adGroupId: a.adGroupId, asins: a.asins })
    if ('refused' in b) return { ok: false, error: b.refused }
    if (!a.targetIds?.length && !a.expressions?.length && b.group) {
      if (b.group.targets.length > SD_MAX_CLAUSES) return { ok: false, error: `Ad group ${b.group.name} has more than ${SD_MAX_CLAUSES} targets; Amazon takes ${SD_MAX_CLAUSES} a request: name them with targetIds.` }
      for (const t of b.group.targets) {
        if (Array.isArray(t.expression) && t.expression.length) clauses.push({ targetId: t.targetId, expression: t.expression as SdExpressionJson, resolved: t.resolvedExpression, currentBidCents: t.bidCents })
        else notRead.push(t.targetId)
      }
    }
    if (!clauses.length) {
      return { ok: false, error: notRead.length ? `Nexus has not read these targets' expressions from Amazon yet (${notRead.length}): give expressions, or ask again after the next SD sync.` : 'Give targetIds or expressions, or an SD ad group with targets (adGroupId).' }
    }
    if (clauses.length > SD_MAX_CLAUSES) return { ok: false, error: `Amazon takes ${SD_MAX_CLAUSES} clauses a request, not ${clauses.length}: ask in parts.` }
    const costType = a.costType ?? (b.group?.campaign.costType === 'vcpm' ? 'vcpm' : 'cpc')
    const fromGroup = b.group?.bidOptimization && BID_OPTIMIZATIONS[costType].includes(b.group.bidOptimization) ? b.group.bidOptimization : null
    const bidOptimization = a.bidOptimization ?? (fromGroup as 'clicks' | 'conversions' | 'reach' | null) ?? (costType === 'vcpm' ? 'reach' : 'clicks')
    if (!BID_OPTIMIZATIONS[costType].includes(bidOptimization)) return { ok: false, error: `Bid optimization ${bidOptimization} does not go with cost type ${costType}: ${costType} takes ${BID_OPTIMIZATIONS[costType].join(' or ')}.` }
    const creativeType = a.creativeType ?? (b.group?.creativeType === 'VIDEO' ? 'VIDEO' : 'IMAGE')
    const p = await profileOf(b.market)
    if ('refused' in p) return { ok: false, error: p.refused }
    const r = await sdBidRecommendations(p.ctx, { asins: b.asins, costType, bidOptimization, creativeType, expressions: clauses.map((c) => c.expression) })
    const currency = b.group ? campaignCurrency(b.group.campaign) : await currencyOfMarket(p.market)
    return {
      ok: true,
      data: {
        market: p.market, currency, costType, bidOptimization, creativeType, asins: b.asins,
        ...(b.group ? { adGroup: { adGroupId: b.group.adGroupId, name: b.group.name, campaign: b.group.campaign.name } } : {}),
        items: clauses.map((c, i) => {
          const bid = r.bids[i]
          return {
            ...(c.targetId ? { targetId: c.targetId, currentBidCents: c.currentBidCents } : {}),
            inWords: sdExpressionInWords(c.expression, c.resolved),
            expression: c.expression,
            ...(bid?.ok
              ? { recommendedBidCents: toCents(bid.recommended), bidRangeLowCents: toCents(bid.rangeLower), bidRangeHighCents: toCents(bid.rangeUpper) }
              : { noBid: bid ? `Amazon gave no bid: ${[bid.code, bid.details].filter(Boolean).join(' — ') || 'no reason given'}` : 'Amazon gave no answer for this clause.' }),
          }
        }),
        ...(notRead.length ? { notRead: { targetIds: notRead.slice(0, 20), why: 'Nexus has not read these targets\' expressions from Amazon yet (the SD sync runs every 20 minutes).' } } : {}),
      },
    }
  }),
}

export const ADS_SD_TOOLS: AgentTool[] = [sdAudiences, sdCategories, sdTargetingRecs, sdBidRecs]
