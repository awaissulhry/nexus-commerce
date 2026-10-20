/**
 * SD CREATE P2a (2026-10-20; the Owner: "give the MCP the ability to control and manage it all exactly from A to Z") —
 * Claude CREATES Amazon Sponsored Display parts through the create tools that already exist, each as one approval
 * request with a full preview:
 *
 *   create-ad-campaign (adProduct SD)  a campaign — tactic T00020 (contextual) or T00030 (audiences, and contextual since
 *                                      2024-08), how it pays (cpc | vcpm, fixed once made), daily budget, first and last
 *                                      day, portfolio — and, in the SAME call (new parts that point at new parts are one
 *                                      call), one ad group with its product ads and targets.
 *   create-ad-group                    an ad group in an EXISTING SD campaign, with its product ads and targets.
 *   add-product-ads                    SKUs into an SD ad group.
 *   add-ad-targets                     targets into an SD ad group, in plain typed words (`sdTargets`), never expressions.
 *
 * One SD create path, the screens' own (ads-create.service.ts): createCampaignLocal (type SD, born PAUSED),
 * createAdGroupLocal, createProductAdLocal, createTargetLocal — the SD endpoints and their expression dialect
 * (sd-target-expression.ts) — and the launch's read-back (verifyLaunch) when it went live. This file only decides and
 * says what those creates will do.
 *
 * Safe by construction (the Owner's rules for an SD create):
 *   born paused    a new SD campaign is created PAUSED and OFF the live-write allowlist. Nothing serves until a person
 *                  switches it on (enable-ads, its own request: SPENDS MONEY); the preview says so.
 *   a person       every SD create waits for a person: never by the business's rule (SD_BY_RULE). The ads strategy's bid
 *                  limits and floors are per Sponsored Products click and cannot judge a vCPM bid.
 *   out of stock   a product out of stock is advertised too, by default (Owner 2026-10-20: it costs nothing while Amazon
 *                  cannot sell it, and it is there the moment stock is back); `includeOutOfStock: false` leaves it out.
 *                  The preview names each product's SKU, its ASIN and whether it is in stock.
 *   Amazon's range every bid and the budget are judged on Amazon's SD range for the campaign's cost type (CPC or vCPM),
 *                  before anything is queued. Sellers advertise by SKU (the create sends the seller SKU Amazon holds).
 *   undo           a campaign or an ad group is archived (archive-ads): for good at Amazon, said in the preview. New
 *                  product ads and targets are paused (pause-ads).
 * Like every ad change tool (ads-change-kit.ts): a refusal is not queued, it runs only as an approved request as the
 * approver, and it refuses when what was approved moved (`plan` / `basis`, `reach`).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { SPONSORED_DISPLAY, adProductOf } from '@nexus/shared/ads-ad-product'
import { marketLimitsRefusal } from '@nexus/shared/ads-market-limits'
import { campaignNameProblem } from '@nexus/shared/ads-campaign-name'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { AdSkuConflictError, campaignNamedInMarket, resolveSellerSku } from '../../advertising/ads-create.service.js'
import { adGroupNamedInCampaign } from '../../advertising/ad-group-lookup.service.js'
import { readProductStock } from '../../advertising/ads-stock-risk.service.js'
import { SD_LOOKBACK_DAYS, SD_SIMILAR_PRODUCT, SdTargetRefused, sdExpressionValue, sdTargetExpression } from '../../advertising/sd-target-expression.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { STEP_UP_NEEDS } from '../step-up-approval.js'
import { isRuleApprovedRun, type ToolContext, type ToolResult } from '../tool-types.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, ruleFactsFor, storedReach, type StoredReach } from './ads-change-kit.js'
import { codeGate, DAY_TO_DAY_NO_CODE, needsCode } from './ads-code-rule.js'
import type { KitItem } from './ads-autonomy-kit.js'

/** The most product ads and targets one SD request makes (the tool contract's bound for a list). */
export const SD_LIST_MAX = 250
/** At most this many lines are listed in a preview; the rest are counted. */
const LINES_SHOWN = 20

export const SD_TACTICS = ['T00020', 'T00030'] as const
export const SD_COST_TYPES = ['cpc', 'vcpm'] as const
export const SD_BID_OPTIMIZATIONS = ['clicks', 'conversions', 'reach'] as const
export const SD_CREATIVE_TYPES = ['IMAGE', 'VIDEO'] as const
type Tactic = (typeof SD_TACTICS)[number]
type CostType = (typeof SD_COST_TYPES)[number]
type BidOptimization = (typeof SD_BID_OPTIMIZATIONS)[number]
type CreativeType = (typeof SD_CREATIVE_TYPES)[number]

const TACTIC_WORDS: Record<Tactic, string> = {
  T00020: 'contextual (T00020: product, category and similar-products targets)',
  T00030: 'audiences (T00030: audiences and remarketing, and contextual targets too)',
}
const PAYS_WORDS: Record<CostType, string> = { cpc: 'per click (CPC)', vcpm: 'per thousand viewable impressions (vCPM)' }

/** Why a Sponsored Display create never runs by the business's rule (each tool's `withinLimits` says it first). */
export const SD_BY_RULE = 'it creates Sponsored Display parts, which only a person approves (a new campaign is born paused, and the ads strategy\'s bid limits and floors are per Sponsored Products click, so they cannot judge it); a person decides'

/** True for a campaign of Sponsored Display (either column). */
export const isSdCampaign = (c: { adProduct?: string | null; type?: unknown }) => adProductOf({ adProduct: c.adProduct ?? null, type: c.type == null ? null : String(c.type) }) === SPONSORED_DISPLAY

/** `withinLimits`, first: an SD preview never runs by rule. Null for every other preview. Pure. */
export function sdByRuleRefusal(preview: unknown): string | null {
  return (preview as { adProduct?: unknown } | null | undefined)?.adProduct === 'SD' ? SD_BY_RULE : null
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const named = (list: readonly string[], shown = 3) => (list.length > shown ? `${list.slice(0, shown).join(', ')} and ${list.length - shown} more` : list.join(', '))
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')

// ── Arguments ─────────────────────────────────────────────────────────────────────────────────────

const DAY = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day is YYYY-MM-DD')
const DIGITS = (what: string) => z.string().trim().regex(/^\d{1,30}$/, `${what} is Amazon's numeric id`)

/** One Sponsored Display target in plain words (never an expression): Nexus builds Amazon's expression from it. */
export const SD_TARGET_ARG = z.object({
  type: z.enum(['product', 'category', 'similarProducts', 'views', 'purchases', 'audience'])
    .describe('product: ads on one product\'s page (asin); category: on products of a category (categoryId, refinements optional); similarProducts: on products similar to the advertised ones; views / purchases: people who viewed / bought (scope, lookbackDays) — remarketing; audience: an Amazon audience (audienceId). Contextual kinds (product, category, similarProducts) fit both tactics; views, purchases and audience need an audiences (T00030) campaign'),
  asin: z.string().trim().toUpperCase().regex(/^B0[A-Z0-9]{8}$/, 'an ASIN is B0 and 8 letters or digits').optional().describe('product: the ASIN whose page shows the ad'),
  categoryId: DIGITS('a category id').optional().describe('category, or views / purchases with scope "category": Amazon\'s category id'),
  brandId: DIGITS('a brand id').optional().describe('a refinement of a category: only products of this brand (Amazon\'s brand id)'),
  priceMinCents: z.coerce.number().int().min(0).max(100_000_000).optional().describe("a refinement of a category: only products priced above this, in minor units of the market's currency (Amazon: not inclusive)"),
  priceMaxCents: z.coerce.number().int().min(1).max(100_000_000).optional().describe("a refinement of a category: only products priced below this, in minor units of the market's currency (Amazon: not inclusive)"),
  ratingMin: z.coerce.number().min(0).max(5).optional().describe('a refinement of a category: only products rated above this (0 to 5)'),
  ratingMax: z.coerce.number().min(0).max(5).optional().describe('a refinement of a category: only products rated below this (0 to 5)'),
  prime: z.literal(true).optional().describe('a refinement of a category: true = only products that ship with Prime'),
  scope: z.enum(['exactProduct', 'similarProduct', 'relatedProduct', 'category']).optional()
    .describe('views / purchases: what they viewed or bought — exactProduct: the advertised products (default); similarProduct: products similar to them (views only); relatedProduct: related products (purchases only); category: products of categoryId (refinements allowed)'),
  lookbackDays: z.coerce.number().int().optional().describe('views / purchases: how far back, in days — views 7, 14, 30, 60 or 90; purchases also 180 or 365 (default 30)'),
  audienceId: DIGITS('an audience id').optional().describe('audience: the Amazon audience id (audiences are listed by Amazon\'s audience lookup)'),
  bidCents: z.coerce.number().int().min(2).max(100_000).optional()
    .describe("its bid in minor units of the market's currency — per click in a cpc campaign, per thousand viewable impressions in a vcpm one (default: the ad group's default bid)"),
})
export type SdTargetArg = z.infer<typeof SD_TARGET_ARG>

export const sdTargetsArg = (more = '') => z.array(SD_TARGET_ARG).max(SD_LIST_MAX)
  .describe(`Sponsored Display only — the targets, each in plain words (type and its fields), at most ${SD_LIST_MAX}${more}`)
export const includeOutOfStockArg = z.boolean().optional()
  .describe('Sponsored Display only — false: leave out products that are out of stock now. Default true: they are advertised too (an ad costs nothing while Amazon cannot sell the product, and it serves the moment stock is back)')
export const bidOptimizationArg = z.enum(SD_BID_OPTIMIZATIONS).optional()
  .describe('Sponsored Display only — what Amazon optimises the ad group\'s bids for: clicks or conversions in a cpc campaign (default conversions), reach in a vcpm one (the only choice there)')
export const creativeTypeArg = z.enum(SD_CREATIVE_TYPES).optional()
  .describe('Sponsored Display only — the ad group\'s creative: IMAGE (default) or VIDEO (a video asset is needed before it serves)')

/** The SD-only argument names: given for a Sponsored Products place, the request is refused rather than half-read. */
const SD_ONLY_ARGS = ['sdTargets', 'includeOutOfStock', 'bidOptimization', 'creativeType', 'tactic', 'costType', 'startDate', 'endDate'] as const

/** The SD-only arguments a request names, for a refusal at a Sponsored Products place. */
export function sdArgsGiven(raw: Record<string, unknown>): string[] {
  return SD_ONLY_ARGS.filter((k) => raw[k] !== undefined && raw[k] !== null)
}

// ── A target, in words and as Nexus stores it ─────────────────────────────────────────────────────

/** One target as the create sends it (createTargetLocal's fields) and as a person reads it. */
export interface SdPlannedTarget {
  kind: 'PRODUCT' | 'CATEGORY' | 'AUDIENCE'
  /** The line of text the target's expression is built from and Nexus stores (sd-target-expression.ts). */
  value: string
  audienceType: 'VIEWS_REMARKETING' | 'PURCHASES_REMARKETING' | 'AUDIENCE' | null
  lookbackDays: number | null
  /** Contextual (product, category, similar products): every tactic takes it. */
  contextual: boolean
  words: string
  bidCents: number
}

const money = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, '')

/** A category's refinements as Nexus's tokens and as words, from the typed fields; or the problem. */
function refinementsOf(t: SdTargetArg, currency: string): { tokens: string[]; words: string[] } | { refusal: string } {
  const tokens: string[] = []
  const words: string[] = []
  if (t.brandId) { tokens.push(`brand=${t.brandId}`); words.push(`brand ${t.brandId}`) }
  const lo = t.priceMinCents, hi = t.priceMaxCents
  if (lo != null && hi != null) {
    if (lo >= hi) return { refusal: 'priceMinCents must be below priceMaxCents' }
    tokens.push(`price=${money(lo)}-${money(hi)}`); words.push(`priced between ${amountLabel(lo, currency)} and ${amountLabel(hi, currency)}`)
  } else if (lo != null) { tokens.push(`price>${money(lo)}`); words.push(`priced above ${amountLabel(lo, currency)}`) }
  else if (hi != null) { tokens.push(`price<${money(hi)}`); words.push(`priced below ${amountLabel(hi, currency)}`) }
  const rlo = t.ratingMin, rhi = t.ratingMax
  if (rlo != null && rhi != null) {
    if (rlo >= rhi) return { refusal: 'ratingMin must be below ratingMax' }
    tokens.push(`rating=${rlo}-${rhi}`); words.push(`rated between ${rlo} and ${rhi}`)
  } else if (rlo != null) { tokens.push(`rating>${rlo}`); words.push(`rated above ${rlo}`) }
  else if (rhi != null) { tokens.push(`rating<${rhi}`); words.push(`rated below ${rhi}`) }
  if (t.prime) { tokens.push('prime=true'); words.push('Prime only') }
  return { tokens, words }
}

const REFINING = ['brandId', 'priceMinCents', 'priceMaxCents', 'ratingMin', 'ratingMax', 'prime'] as const

/**
 * One typed target as the create's fields and in words, checked by the expression builder itself (sdTargetExpression:
 * what Amazon would refuse is refused here, with its sentence); `defaultBidCents` when it names no bid of its own.
 */
function sdTargetOf(t: SdTargetArg, ctx: { currency: string; defaultBidCents: number }): SdPlannedTarget | { refusal: string } {
  const unused = (allowed: readonly string[]) => (Object.keys(t) as Array<keyof SdTargetArg>)
    .filter((k) => k !== 'type' && k !== 'bidCents' && t[k] !== undefined && !allowed.includes(k))
  const refinable = t.type === 'category' || ((t.type === 'views' || t.type === 'purchases') && t.scope === 'category')
  const allowed: Record<SdTargetArg['type'], readonly string[]> = {
    product: ['asin'], similarProducts: [], audience: ['audienceId'],
    category: ['categoryId', ...REFINING],
    views: ['scope', 'lookbackDays', ...(refinable ? ['categoryId', ...REFINING] : [])],
    purchases: ['scope', 'lookbackDays', ...(refinable ? ['categoryId', ...REFINING] : [])],
  }
  const extra = unused(allowed[t.type])
  if (extra.length) return { refusal: `a ${t.type} target does not take ${extra.join(', ')}${extra.some((k) => (REFINING as readonly string[]).includes(k)) ? ' (brand, price, rating and Prime refine a category)' : ''}` }
  const bidCents = t.bidCents ?? ctx.defaultBidCents
  let planned: Omit<SdPlannedTarget, 'bidCents' | 'value'> & { value: string }
  if (t.type === 'product') {
    if (!t.asin) return { refusal: 'a product target names its asin' }
    planned = { kind: 'PRODUCT', value: t.asin, audienceType: null, lookbackDays: null, contextual: true, words: `the product page of ${t.asin}` }
  } else if (t.type === 'similarProducts') {
    planned = { kind: 'PRODUCT', value: SD_SIMILAR_PRODUCT, audienceType: null, lookbackDays: null, contextual: true, words: 'products similar to the advertised ones' }
  } else if (t.type === 'category') {
    if (!t.categoryId) return { refusal: 'a category target names its categoryId' }
    const r = refinementsOf(t, ctx.currency)
    if ('refusal' in r) return r
    planned = { kind: 'CATEGORY', value: [t.categoryId, ...r.tokens].join(' '), audienceType: null, lookbackDays: null, contextual: true, words: `products in category ${t.categoryId}${r.words.length ? ` (${r.words.join(', ')})` : ''}` }
  } else if (t.type === 'audience') {
    if (!t.audienceId) return { refusal: 'an audience target names its audienceId' }
    planned = { kind: 'AUDIENCE', value: t.audienceId, audienceType: 'AUDIENCE', lookbackDays: null, contextual: false, words: `the Amazon audience ${t.audienceId}` }
  } else {
    const event = t.type
    const scope = t.scope ?? 'exactProduct'
    const lookbackDays = t.lookbackDays ?? 30
    if (!SD_LOOKBACK_DAYS[event].includes(lookbackDays)) return { refusal: `Amazon accepts a ${event} window of ${SD_LOOKBACK_DAYS[event].join(', ')} days, not ${lookbackDays}` }
    const did = event === 'views' ? 'viewed' : 'bought'
    let what: string
    let value: string
    if (scope === 'category') {
      if (!t.categoryId) return { refusal: `a ${event} target with scope "category" names its categoryId` }
      const r = refinementsOf(t, ctx.currency)
      if ('refusal' in r) return r
      value = [t.categoryId, ...r.tokens].join(' ')
      what = `products in category ${t.categoryId}${r.words.length ? ` (${r.words.join(', ')})` : ''}`
    } else {
      if (t.categoryId) return { refusal: `a ${event} target takes categoryId only with scope "category"` }
      value = scope
      what = scope === 'exactProduct' ? 'the advertised products' : scope === 'similarProduct' ? 'products similar to the advertised ones' : 'products related to the advertised ones'
    }
    planned = { kind: 'AUDIENCE', value, audienceType: event === 'views' ? 'VIEWS_REMARKETING' : 'PURCHASES_REMARKETING', lookbackDays, contextual: false, words: `people who ${did} ${what} in the last ${lookbackDays} days` }
  }
  // The expression builder is the judge: what Amazon would refuse is refused here, and the value is stored as it reads back.
  try {
    const expression = sdTargetExpression({ kind: planned.kind, value: planned.value, audienceType: planned.audienceType, lookbackDays: planned.lookbackDays })
    return { ...planned, value: sdExpressionValue(expression) ?? planned.value, bidCents }
  } catch (e) {
    if (e instanceof SdTargetRefused) return { refusal: e.message.replace(/\.$/, '') }
    throw e
  }
}

/** The targets of a request, checked: each its own, none twice, and the tactic takes it. */
function plannedTargetsOf(list: readonly SdTargetArg[], ctx: { currency: string; defaultBidCents: number; tactic: Tactic }): { targets: SdPlannedTarget[] } | { refusal: string } {
  const targets: SdPlannedTarget[] = []
  const problems: string[] = []
  for (const [i, t] of list.entries()) {
    const p = sdTargetOf(t, ctx)
    if ('refusal' in p) { problems.push(`sdTargets[${i}]: ${p.refusal}`); continue }
    // SD 3.0 `TargetingPredicateNested` is "only applicable to audience targeting — T00030"; a contextual campaign
    // (T00020) takes product, category and similar-products targets (`TargetingPredicate`) only.
    if (ctx.tactic === 'T00020' && !p.contextual) { problems.push(`sdTargets[${i}] (${p.words}): a contextual (T00020) campaign takes product, category and similar-products targets only; audiences and remarketing need an audiences (T00030) campaign`); continue }
    targets.push(p)
  }
  if (problems.length) return { refusal: `Not queued: ${named(problems, 5)}.` }
  const seen = new Set<string>()
  const twice = targets.filter((t) => { const k = `${t.kind}|${t.audienceType ?? ''}|${t.value.toLowerCase()}`; if (seen.has(k)) return true; seen.add(k); return false })
  if (twice.length) return { refusal: `Not queued: asked for twice — ${named(twice.map((t) => t.words))}. Name each once.` }
  return { targets }
}

// ── The products an SD ad advertises ──────────────────────────────────────────────────────────────

/** One product as an SD ad advertises it: Nexus's SKU, its ASIN in the market, the seller SKU Amazon holds there. */
export interface SdProduct { sku: string; productId: string; asin: string; adSku: string }
/** Its stock now (shown, never approved: stock moves every hour). */
export interface SdStock { sku: string; units: number; inStock: boolean }

/** Listing states of an Amazon offer that is AT Amazon, sellable or not (an out-of-stock offer reads INACTIVE). */
const AT_AMAZON = ['ACTIVE', 'INACTIVE']

/**
 * The products by SKU, each listed at Amazon in this market (an active or inactive offer — out of stock reads inactive —
 * with an ASIN; a draft, ended or failed listing is not at Amazon), a variation rather than its parent, with the seller SKU
 * Amazon holds there (resolveSellerSku). Two SKUs of one ASIN are the same product: refused. Their stock is read alongside.
 * The ASIN is that listing's (the product Amazon holds in this market); the old `Product.amazonAsin` column only when the
 * listing has none — it can hold a sibling size's ASIN (2026-10-21: two sizes refused as "the same product twice").
 */
async function sdProductsOf(skus: readonly string[], market: string): Promise<{ products: SdProduct[]; stock: SdStock[] } | { refusal: string }> {
  const rows = await prisma.product.findMany({ where: { sku: { in: [...skus] }, deletedAt: null }, select: { id: true, sku: true, amazonAsin: true, isParent: true } })
  const bySku = new Map(rows.map((p) => [p.sku, p]))
  const missing = skus.filter((sku) => !bySku.has(sku))
  if (missing.length) return { refusal: `SKU not found in this business: ${named(missing)}.` }
  const parents = rows.filter((p) => p.isParent)
  if (parents.length) return { refusal: `${named(parents.map((p) => p.sku))} ${parents.length === 1 ? 'is a parent' : 'are parents'}: Amazon advertises a variation, never its parent. Name the variations' SKUs.` }
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: rows.map((p) => p.id) }, channel: 'AMAZON', marketplace: market, listingStatus: { in: AT_AMAZON } },
    select: { productId: true, externalListingId: true, aliasKey: true },
    orderBy: { id: 'asc' },
  })
  const asinOf = (p: (typeof rows)[number]): string | null => {
    const own = listings.filter((l) => l.productId === p.id)
    const listed = (own.find((l) => !l.aliasKey) ?? own[0])?.externalListingId?.trim() ?? null
    return listed && /^[A-Z0-9]{10}$/i.test(listed) ? listed.toUpperCase() : p.amazonAsin || null
  }
  const listed = new Set(listings.map((l) => l.productId))
  const notThere = skus.filter((sku) => !listed.has(bySku.get(sku)!.id))
  if (notThere.length) return { refusal: `Not on Amazon ${market}: ${named(notThere)} — no Amazon listing there (a draft, ended, removed or failed listing is not at Amazon; out of stock is fine). An ad advertises only what Amazon holds in its market.` }
  const noAsin = skus.filter((sku) => !asinOf(bySku.get(sku)!))
  if (noAsin.length) return { refusal: `No ASIN on Amazon ${market} yet: ${named(noAsin)}. An ad advertises a product Amazon holds by its ASIN.` }
  const byAsin = new Map<string, string[]>()
  for (const sku of skus) { const asin = asinOf(bySku.get(sku)!)!; byAsin.set(asin, [...(byAsin.get(asin) ?? []), sku]) }
  const shared = [...byAsin].filter(([, list]) => list.length > 1)
  if (shared.length) return { refusal: `The same product twice: ${named(shared.map(([asin, list]) => `${list.join(' and ')} are both ASIN ${asin}`))}. An ad group advertises a product once: name one of them.` }
  const products: SdProduct[] = []
  for (const sku of skus) {
    const p = bySku.get(sku)!
    const asin = asinOf(p)!
    try {
      // Sellers advertise by SKU: the one Amazon holds for this product in the market.
      const resolved = await resolveSellerSku({ sku: p.sku, asin, productId: p.id, marketplace: market })
      products.push({ sku: p.sku, productId: p.id, asin, adSku: resolved?.sku ?? p.sku })
    } catch (e) {
      if (e instanceof AdSkuConflictError) return { refusal: e.message }
      throw e
    }
  }
  const units = await readProductStock(products.map((p) => p.productId))
  const stock = products.map((p) => { const n = units.get(p.productId)?.units ?? 0; return { sku: p.sku, units: n, inStock: n > 0 } })
  return { products, stock }
}

/** The products a request keeps (out-of-stock ones too, unless asked to leave them out), and the ones it leaves out. */
function keptProducts(found: { products: SdProduct[]; stock: SdStock[] }, includeOutOfStock: boolean) {
  const out = new Set(found.stock.filter((s) => !s.inStock).map((s) => s.sku))
  const products = includeOutOfStock ? found.products : found.products.filter((p) => !out.has(p.sku))
  const leftOut = includeOutOfStock ? [] : found.products.filter((p) => out.has(p.sku)).map((p) => p.sku)
  return { products, leftOut, stock: found.stock.filter((s) => products.some((p) => p.sku === s.sku)) }
}

/** The preview's line per product: SKU → ASIN, in stock or not. */
function productLines(products: readonly SdProduct[], stock: readonly SdStock[]) {
  const of = new Map(stock.map((s) => [s.sku, s]))
  return products.slice(0, LINES_SHOWN).map((p) => {
    const s = of.get(p.sku)
    return { sku: p.sku, asin: p.asin, adSku: p.adSku, inStock: s?.inStock ?? false, units: s?.units ?? 0, line: `${p.sku} → ${p.asin}${p.adSku !== p.sku ? ` (seller SKU ${p.adSku})` : ''}: ${s?.inStock ? `in stock (${s.units})` : 'out of stock — advertised on purpose: it serves once stock is back'}` }
  })
}

// ── Amazon's range, where it lands, the ad group's settings ───────────────────────────────────────

/** Amazon's SD range for a bid in this market and cost type, as a refusal sentence; null when Amazon takes it. */
function bidRefusal(market: string, costType: CostType, cents: number): string | null {
  return marketLimitsRefusal({ market, adProduct: SPONSORED_DISPLAY, field: 'bid', valueMinor: cents, costType })
}

/**
 * Where an SD create lands, as the create itself asks the write gate (ads-create.service.ts addGateScope: an SD create
 * is judged on its market, not as a Sponsored Products change of a campaign) — a person's approval as his own click.
 */
async function sdReach(market: string, valueCents: number): Promise<{ reach: StoredReach } | { refusal: string }> {
  const live = liveReachOf(await checkAdsWriteGate({
    marketplace: market, payloadValueCents: valueCents, dimension: 'structure',
    ...(isRuleApprovedRun() ? {} : { manual: true, confirmOwnLimits: true }),
  }))
  return live.reach === 'refused' ? { refusal: reachRefusal(live) } : { reach: storedReach(live) }
}

/** The ad group's bid optimisation for this cost type: the one asked for (refused when it does not fit), else the default. */
function bidOptimizationFor(costType: CostType, asked: BidOptimization | undefined): BidOptimization | { refusal: string } {
  if (costType === 'vcpm') return asked && asked !== 'reach' ? { refusal: `a campaign that pays per thousand viewable impressions (vcpm) optimises for reach only, not ${asked}` } : 'reach'
  if (asked === 'reach') return { refusal: 'a campaign that pays per click (cpc) optimises for clicks or conversions, not reach (reach is for vcpm)' }
  return asked ?? 'conversions'
}

const OPTIMISE_WORDS: Record<BidOptimization, string> = { clicks: 'clicks (page visits)', conversions: 'conversions (sales)', reach: 'reach (viewable impressions)' }

/** One SD ad group as planned (a new campaign's, or one added to an existing campaign). */
export interface SdGroupPlan {
  name: string
  defaultBidCents: number
  bidOptimization: BidOptimization
  creativeType: CreativeType
  products: SdProduct[]
  targets: SdPlannedTarget[]
}

/** The ad group part of a request: its settings, products and targets, each checked. */
async function groupPlanOf(input: {
  market: string; currency: string; tactic: Tactic; costType: CostType
  name: string; defaultBidCents: number; bidOptimization?: BidOptimization; creativeType?: CreativeType
  skus: readonly string[]; sdTargets: readonly SdTargetArg[]; includeOutOfStock: boolean
}): Promise<{ plan: SdGroupPlan; stock: SdStock[]; leftOut: string[] } | { refusal: string }> {
  const opt = bidOptimizationFor(input.costType, input.bidOptimization)
  if (typeof opt !== 'string') return { refusal: `Not queued: ${opt.refusal}.` }
  const repeated = input.skus.filter((sku, i) => input.skus.findIndex((x) => x.toLowerCase() === sku.toLowerCase()) !== i)
  if (repeated.length) return { refusal: `Listed twice in skus: ${named([...new Set(repeated)], 5)}.` }
  let products: SdProduct[] = []
  let stock: SdStock[] = []
  let leftOut: string[] = []
  if (input.skus.length) {
    const found = await sdProductsOf(input.skus, input.market)
    if ('refusal' in found) return found
    const kept = keptProducts(found, input.includeOutOfStock)
    if (!kept.products.length) return { refusal: `Not queued: every product named is out of stock (${named(kept.leftOut)}) and includeOutOfStock is false, so the ad group would advertise nothing. Ask without includeOutOfStock: false to advertise them anyway.` }
    ;({ products, stock, leftOut } = kept)
  }
  const planned = plannedTargetsOf(input.sdTargets, { currency: input.currency, defaultBidCents: input.defaultBidCents, tactic: input.tactic })
  if ('refusal' in planned) return planned
  for (const cents of [...new Set([input.defaultBidCents, ...planned.targets.map((t) => t.bidCents)])]) {
    const wrong = bidRefusal(input.market, input.costType, cents)
    if (wrong) return { refusal: `Not queued: ${wrong}` }
  }
  return {
    plan: { name: input.name, defaultBidCents: input.defaultBidCents, bidOptimization: opt, creativeType: input.creativeType ?? 'IMAGE', products, targets: planned.targets },
    stock, leftOut,
  }
}

/** The ad group in words, for an effect and the preview's lines. */
function groupWords(g: SdGroupPlan, currency: string, costType: CostType): string {
  const per = costType === 'vcpm' ? 'per thousand viewable impressions' : 'per click'
  return `the ad group "${g.name}" (default bid ${amountLabel(g.defaultBidCents, currency)} ${per}, optimised for ${OPTIMISE_WORDS[g.bidOptimization]}, ${g.creativeType} creative) `
    + `with ${plural(g.products.length, 'product ad')} and ${plural(g.targets.length, 'target')}`
}

/** The preview's target lines (as add-ad-targets' cards read them: label, toLabel). */
function targetLines(targets: readonly SdPlannedTarget[], currency: string, costType: CostType) {
  const per = costType === 'vcpm' ? ' per 1,000 viewable impressions' : ' per click'
  return targets.map((t) => ({ label: t.words, kind: t.kind, value: t.value, fromLabel: 'none', toLabel: `at ${amountLabel(t.bidCents, currency)}${per}`, bidCents: t.bidCents, currency }))
}

/** The note every SD create preview carries about spend. */
const spendsWords = (whenOn: string) => `SPENDS MONEY when switched on: ${whenOn}`

// ── create-ad-campaign, adProduct SD ──────────────────────────────────────────────────────────────

/** The SD arguments of create-ad-campaign (the tool's own schema holds them; this reads them, strictly). */
const SD_CAMPAIGN_INPUT = z.object({
  adProduct: z.literal('SD'),
  market: z.string().trim().toUpperCase().min(2).max(20),
  name: z.string().trim().min(1).max(128),
  tactic: z.enum(SD_TACTICS, { message: 'a Sponsored Display campaign names its tactic: T00020 (contextual) or T00030 (audiences)' }),
  costType: z.enum(SD_COST_TYPES).default('cpc'),
  dailyBudgetCents: z.coerce.number().int().positive(),
  startDate: DAY.optional(),
  endDate: DAY.optional(),
  portfolioId: z.string().trim().min(1).max(64).optional(),
  adGroupName: z.string().trim().min(1).max(128).optional(),
  defaultBidCents: z.coerce.number().int().min(2).max(100_000).optional(),
  bidOptimization: z.enum(SD_BID_OPTIMIZATIONS).optional(),
  creativeType: z.enum(SD_CREATIVE_TYPES).optional(),
  skus: z.array(z.string().trim().min(1).max(64)).max(SD_LIST_MAX).optional(),
  sdTargets: z.array(SD_TARGET_ARG).max(SD_LIST_MAX).optional(),
  includeOutOfStock: z.boolean().optional(),
  why: z.string().trim().max(300).optional(),
})

/** What create-ad-campaign SD creates, as approved (it is checked again, value by value, before anything is created). */
export interface SdCampaignPlan {
  adProduct: 'SD'
  market: string
  name: string
  currency: string
  tactic: Tactic
  costType: CostType
  dailyBudgetCents: number
  startDate: string
  endDate: string | null
  portfolio: { id: string; name: string } | null
  /** Its one ad group, when the request names one (its products and targets with it); null: the campaign alone. */
  adGroup: SdGroupPlan | null
  /** Its products (create-ad-campaign's approval card and the ads strategy read `plan.products`). */
  products: SdProduct[]
}

const todayUtc = () => new Date().toISOString().slice(0, 10)

/** The SP-only arguments of create-ad-campaign: given with adProduct SD, refused rather than dropped. */
const SP_CAMPAIGN_ONLY = ['keywords', 'productTargets', 'negativeKeywords'] as const

/** create-ad-campaign's dry run for adProduct SD (its `facts`: the kit's, as for Sponsored Products). */
export async function sdCampaignPreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>, opts: { tool: string; limits: z.ZodObject; undoNote: string }): Promise<ToolResult> {
  const spOnly = SP_CAMPAIGN_ONLY.filter((k) => Array.isArray(raw[k]) ? (raw[k] as unknown[]).length > 0 : raw[k] != null)
  if (spOnly.length) return { ok: false, error: `${spOnly.join(', ')} ${spOnly.length === 1 ? 'is' : 'are'} for a Sponsored Products campaign: a Sponsored Display campaign takes sdTargets (product, category, similar products, views, purchases, audience) and has no keywords.` }
  const parsed = SD_CAMPAIGN_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: issues(parsed.error) }
  const a = parsed.data
  const skus = a.skus ?? []
  const sdTargets = a.sdTargets ?? []
  const wantsGroup = !!(a.adGroupName || a.defaultBidCents != null || skus.length || sdTargets.length || a.bidOptimization || a.creativeType)
  if (wantsGroup && a.defaultBidCents == null) return { ok: false, error: 'Name the ad group\'s default bid (defaultBidCents): its products and targets are created in an ad group, and Amazon needs its default bid.' }

  let currency: string
  try {
    currency = await marketCurrency('AMAZON', a.market)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  // The same spend ceiling a Sponsored Products create needs: one must exist, and the new budget alone must fit under it.
  const ceiling = await prisma.adSpendCeiling.findFirst({
    where: { grain: 'MARKET', scopeId: a.market, enabled: true, dailyCapCents: { not: null } },
    select: { label: true, dailyCapCents: true },
  })
  if (!ceiling) return { ok: false, error: `Set a spend ceiling for this market first: ${a.market} has no daily spend ceiling, and Claude creates a campaign only in a market that has one (Ads → spend ceilings).` }
  const cap = ceiling.dailyCapCents as number
  if (a.dailyBudgetCents > cap) return { ok: false, error: `A daily budget of ${amountLabel(a.dailyBudgetCents, currency)} is above ${ceiling.label}'s spend ceiling of ${amountLabel(cap, currency)} a day.` }
  const budgetWrong = marketLimitsRefusal({ market: a.market, adProduct: SPONSORED_DISPLAY, field: 'dailyBudget', valueMinor: a.dailyBudgetCents })
  if (budgetWrong) return { ok: false, error: `Not queued: ${budgetWrong}` }

  // A name Amazon refuses (an em dash, a middle dot) is said here, not changed behind the person's back at the create.
  const badName = campaignNameProblem(a.name) ?? (a.adGroupName ? campaignNameProblem(a.adGroupName) : null)
  if (badName) return { ok: false, error: `Not queued: ${badName}` }
  const taken = await campaignNamedInMarket(a.market, a.name)
  if (taken) return { ok: false, error: `${a.market} already has a campaign named "${taken.name}" (${taken.id}): give the new one another name.` }

  // Amazon: the start "must be today or in the future"; the end, when given, after it.
  const startDate = a.startDate ?? todayUtc()
  if (startDate < todayUtc()) return { ok: false, error: `The start date ${startDate} is in the past: Amazon starts a campaign today or later.` }
  if (a.endDate && a.endDate < startDate) return { ok: false, error: `The end date ${a.endDate} is before the start date ${startDate}.` }

  // The portfolio: one of this business's at Amazon, on the market's own Amazon Ads profile.
  let portfolio: SdCampaignPlan['portfolio'] = null
  if (a.portfolioId) {
    if (a.portfolioId.startsWith('local-pf-')) return { ok: false, error: `The portfolio ${a.portfolioId} lives in Nexus only (Amazon never took it): a campaign cannot be born in it.` }
    const pf = await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: a.portfolioId }, select: { externalPortfolioId: true, name: true, profileId: true } })
    if (!pf) return { ok: false, error: `Portfolio not found: ${a.portfolioId} (ad-portfolios lists them).` }
    const { adsClientContextFor } = await import('../../advertising/ads-profile-resolver.js')
    const profile = await adsClientContextFor(a.market)
    if (profile && pf.profileId !== profile.profileId) return { ok: false, error: `The portfolio "${pf.name}" belongs to another Amazon Ads profile than ${a.market}'s: a campaign is born in a portfolio of its own profile.` }
    const elsewhere = await prisma.campaign.findFirst({ where: { portfolioId: a.portfolioId, marketplace: { not: a.market } }, select: { marketplace: true } })
    if (elsewhere) return { ok: false, error: `The portfolio "${pf.name}" holds campaigns of ${elsewhere.marketplace}: a portfolio belongs to one market, pick one of ${a.market}.` }
    portfolio = { id: pf.externalPortfolioId, name: pf.name }
  }

  let group: { plan: SdGroupPlan; stock: SdStock[]; leftOut: string[] } | null = null
  if (wantsGroup) {
    const planned = await groupPlanOf({
      market: a.market, currency, tactic: a.tactic, costType: a.costType, name: a.adGroupName ?? `${a.name} Ad Group`,
      defaultBidCents: a.defaultBidCents!, bidOptimization: a.bidOptimization, creativeType: a.creativeType,
      skus, sdTargets, includeOutOfStock: a.includeOutOfStock !== false,
    })
    if ('refusal' in planned) return { ok: false, error: planned.refusal }
    // Amazon refuses a bid above the daily budget.
    const highest = Math.max(planned.plan.defaultBidCents, ...planned.plan.targets.map((t) => t.bidCents))
    if (a.costType === 'cpc' && highest > a.dailyBudgetCents) return { ok: false, error: `A bid of ${amountLabel(highest, currency)} is above the daily budget of ${amountLabel(a.dailyBudgetCents, currency)}.` }
    group = planned
  }
  const adGroup = group?.plan ?? null

  const reached = await sdReach(a.market, a.dailyBudgetCents)
  if ('refusal' in reached) return { ok: false, error: reached.refusal }
  const plan: SdCampaignPlan = {
    adProduct: 'SD', market: a.market, name: a.name, currency, tactic: a.tactic, costType: a.costType,
    dailyBudgetCents: a.dailyBudgetCents, startDate, endDate: a.endDate ?? null, portfolio, adGroup, products: adGroup?.products ?? [],
  }
  // The kit's facts, as for a Sponsored Products create (the strategy where its products are); an SD create never runs by rule.
  const items: KitItem[] = [{ entity: { kind: 'products', market: plan.market, productIds: plan.products.map((p) => p.productId) }, change: { field: 'dailyBudget', fromCents: null, toCents: plan.dailyBudgetCents } }]
  const rule = await ruleFactsFor({ tool: opts.tool, limits: opts.limits, items, writes: [], approvalId: ctx.approvalId ?? null })
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: plan.market }, select: { id: true } }))
  const stock = group?.stock ?? []
  const leftOut = group?.leftOut ?? []
  const days = `from ${plan.startDate}${plan.endDate ? ` to ${plan.endDate}` : ', with no end date'}`
  const effect = `Creates the Sponsored Display campaign "${plan.name}" in ${plan.market}: ${TACTIC_WORDS[plan.tactic]}, paying ${PAYS_WORDS[plan.costType]}, `
    + `a daily budget of ${amountLabel(plan.dailyBudgetCents, currency)}, ${days}${plan.portfolio ? `, in the portfolio "${plan.portfolio.name}"` : ''}`
    + `${adGroup ? `, and ${groupWords(adGroup, currency, plan.costType)}` : ' (no ad group yet: create-ad-group adds one)'}. `
    + 'It is born PAUSED and off the live-write allowlist: nothing serves and nothing is spent until a person switches it on.'
    + (leftOut.length ? ` Left out, as asked (out of stock): ${named(leftOut)}.` : '')
  return {
    ok: true,
    preview: {
      action: opts.tool,
      adProduct: 'SD',
      plan,
      ceiling: { label: ceiling.label, dailyCapCents: cap },
      bornPaused: { note: 'Born PAUSED: Amazon serves nothing of it until enable-ads switches it on — that request SPENDS MONEY and a person approves it, never a rule.' },
      liveWrites: false,
      spendsMoney: spendsWords(`up to ${amountLabel(plan.dailyBudgetCents, currency)} a day once a person switches it on (enable-ads); nothing while it is paused.`),
      ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaign in ${plan.market}.` } : {}),
      ...(adGroup ? {
        adGroup: { name: adGroup.name, defaultBidCents: adGroup.defaultBidCents, bidOptimization: adGroup.bidOptimization, creativeType: adGroup.creativeType },
        products: productLines(adGroup.products, stock),
        ...(adGroup.products.length > LINES_SHOWN ? { moreProducts: adGroup.products.length - LINES_SHOWN } : {}),
        outOfStock: { count: stock.filter((s) => !s.inStock).length, note: 'Out-of-stock products are advertised on purpose (Owner 2026-10-20): an ad costs nothing while Amazon cannot sell the product, and serves once stock is back.' },
        changes: targetLines(adGroup.targets, currency, plan.costType).slice(0, LINES_SHOWN),
        ...(adGroup.targets.length > LINES_SHOWN ? { moreChanges: adGroup.targets.length - LINES_SHOWN } : {}),
      } : {}),
      ...(leftOut.length ? { leftOut } : {}),
      reach: reached.reach,
      reachNote: reachNote(reached.reach),
      effect,
      nextSteps: [
        'enable-ads (campaignIds: the new campaign, includePeoplesPauses: true): switches it on — SPENDS MONEY; a person approves it, never a rule',
        'set-campaign-live-writes (enabled: true): only an allowlisted campaign takes an approved change by rule (a person approves it)',
      ],
      undoNote: opts.undoNote,
      ...rule,
    },
  }
}

/** The created rows a run records and approval-status counts: the campaign (and everything under it). */
interface Made { productAds: string[]; targets: string[]; failed: string[] }

/** One ad group's products and targets, created as the screens create them, as the approver; what did not land is listed. */
async function createInGroup(adGroupId: string, g: Pick<SdGroupPlan, 'products' | 'targets'>, common: Record<string, unknown>): Promise<Made> {
  const { createProductAdLocal, createTargetLocal } = await import('../../advertising/ads-create.service.js')
  const made: Made = { productAds: [], targets: [], failed: [] }
  const said = (r: { reason?: string | null; notSent?: { reason: string } | null; outcome?: string }) => r.reason ?? r.notSent?.reason ?? r.outcome ?? 'not created'
  for (const p of g.products) {
    try {
      const r = await createProductAdLocal({ adGroupId, sku: p.sku, asin: p.asin, productId: p.productId, ...common })
      if (r.id && r.ok !== false) made.productAds.push(r.id)
      else made.failed.push(`the ad of ${p.sku} (${said(r)})`)
    } catch (e) { made.failed.push(`the ad of ${p.sku} (${(e as Error).message})`) }
  }
  for (const t of g.targets) {
    try {
      const r = await createTargetLocal({
        adGroupId, kind: t.kind, value: t.value, bidEur: t.bidCents / 100, ...common,
        ...(t.audienceType ? { audienceType: t.audienceType } : {}), ...(t.lookbackDays ? { lookbackDays: t.lookbackDays } : {}),
      })
      if (r.id && r.ok !== false) made.targets.push(r.id)
      else made.failed.push(`target ${t.words} (${said(r)})`)
    } catch (e) { made.failed.push(`target ${t.words} (${(e as Error).message})`) }
  }
  return made
}

/** Amazon's read-back of what a live run made (the launch's receipt); null in sandbox or when the read fails. */
async function readBack(campaignId: string, reach: StoredReach): Promise<{ ok: boolean; problems: string[] } | null> {
  if (reach.reach !== 'live') return null
  try {
    const { verifyLaunch } = await import('../../advertising/ads-launch-verify.service.js')
    const v = await verifyLaunch([campaignId])
    return { ok: v.problems.length === 0, problems: v.problems.slice(0, LINES_SHOWN) }
  } catch (e) {
    // A failed READ is not a failed write: said in the log, not as a failure of the create.
    logger.warn('[P2a] SD create read-back failed', { campaignId, error: (e as Error).message })
    return null
  }
}

/** create-ad-campaign's run for adProduct SD: born paused, then its ad group, products and targets. */
export async function sdCampaignRun(args: Record<string, unknown>, ctx: ToolContext, opts: { tool: string; limits: z.ZodObject; undoNote: string }): Promise<ToolResult> {
  const fresh = await sdCampaignPreview(args, ctx, opts)
  const refusal = recheck(ctx, fresh, ['plan', 'ceiling', 'reach'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { plan: SdCampaignPlan; reach: StoredReach; effect: string }
  const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const plan = p.plan
  const { createCampaignLocal, createAdGroupLocal } = await import('../../advertising/ads-create.service.js')
  const day = (d: string) => new Date(`${d}T12:00:00Z`)
  let campaign: Awaited<ReturnType<typeof createCampaignLocal>>
  try {
    campaign = await createCampaignLocal({
      name: plan.name, type: 'SD', marketplace: plan.market, dailyBudgetEur: plan.dailyBudgetCents / 100,
      sdTactic: plan.tactic, sdCostType: plan.costType, sdStartDate: day(plan.startDate), sdEndDate: plan.endDate ? day(plan.endDate) : null,
      ...(plan.portfolio ? { portfolioId: plan.portfolio.id } : {}),
      // Born PAUSED (the Owner's rule for a Display campaign) and off the allowlist (the column's default).
      startEnabled: false, userId: run.actor, changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits,
    })
  } catch (e) {
    return notRun(`Not run: ${(e as Error).message}`)
  }
  if (!campaign.externalCampaignId) {
    return notRun(`Not run: Amazon did not take the campaign — ${campaign.reason ?? 'no reason given'}. Nothing reached Amazon; Nexus keeps its row "${plan.name}" (${campaign.id}) marked failed with that reason.`)
  }
  const change = { before: { campaignId: null }, after: { campaignId: campaign.id, name: plan.name, market: plan.market } }
  const common = { userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, requireAmazon: true }
  const failed: string[] = []
  let adGroupId: string | null = null
  let made: Made = { productAds: [], targets: [], failed: [] }
  // The campaign is at Amazon now: whatever stops after this, the change is recorded (undo archives it) and says what did not land.
  if (plan.adGroup) {
    const g = plan.adGroup
    try {
      const group = await createAdGroupLocal({ campaignId: campaign.id, name: g.name, defaultBidEur: g.defaultBidCents / 100, sdBidOptimization: g.bidOptimization, sdCreativeType: g.creativeType, ...common })
      if (group.id && group.externalAdGroupId) {
        adGroupId = group.id
        made = await createInGroup(group.id, g, common)
      } else failed.push(`the ad group "${g.name}" (${group.reason ?? group.notSent?.reason ?? 'not created'}) — and so its ${plural(g.products.length, 'product ad')} and ${plural(g.targets.length, 'target')}`)
    } catch (e) { failed.push(`the ad group "${g.name}" (${(e as Error).message})`) }
  }
  failed.push(...made.failed)
  const verification = await readBack(campaign.id, p.reach)
  const data = {
    campaignId: campaign.id, externalCampaignId: campaign.externalCampaignId, status: 'PAUSED', liveWrites: false,
    adGroupId, created: { adGroups: adGroupId ? 1 : 0, productAds: made.productAds.length, targets: made.targets.length },
    currency: plan.currency, reach: p.reach, changeSetId: run.changeSetId,
    ...(verification ? { verification } : {}),
    nextSteps: [`enable-ads {"campaignIds":["${campaign.id}"],"includePeoplesPauses":true} — SPENDS MONEY once on`, ...(adGroupId ? [] : [`create-ad-group {"campaignId":"${campaign.id}", …}`])],
  }
  if (failed.length) {
    return { ok: true, data: { ...data, partial: true, notCreated: failed.slice(0, LINES_SHOWN), note: `Created part-way: ${plural(failed.length, 'part')} did not reach Amazon — ${named(failed)}. The campaign "${plan.name}" (${campaign.id}) is paused and holds what was made; check it with ad-campaigns and ad-groups before asking for more. Undo archives it (archive-ads).` }, change }
  }
  return { ok: true, data, change }
}

// ── create-ad-group, in an existing SD campaign ───────────────────────────────────────────────────

interface SdCampaignRow { id: string; name: string; marketplace: string | null; status: unknown; externalCampaignId: string | null; dailyBudget: unknown; dailyBudgetCurrency: string | null; liveBidWritesEnabled: boolean; tactic: string | null; costType: string | null }

async function sdCampaignOf(id: string): Promise<SdCampaignRow | null> {
  return prisma.campaign.findFirst({
    where: { id },
    select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true, dailyBudget: true, dailyBudgetCurrency: true, liveBidWritesEnabled: true, tactic: true, costType: true },
  })
}

/** The tactic and cost type Nexus holds for an SD campaign, or why it cannot tell (never guessed). */
function tacticAndPays(c: SdCampaignRow): { tactic: Tactic; costType: CostType } | { refusal: string } {
  const tactic = (c.tactic ?? '').trim().toUpperCase()
  const pays = (c.costType ?? '').trim().toLowerCase()
  if (tactic !== 'T00020' && tactic !== 'T00030') return { refusal: `Nexus does not hold the tactic of campaign "${c.name}" (contextual T00020 or audiences T00030), so it cannot tell which targets it takes: let the next sync read it` }
  if (pays !== 'cpc' && pays !== 'vcpm') return { refusal: `Nexus does not hold how campaign "${c.name}" pays (per click or per thousand viewable impressions), and Amazon's bid range and bid optimisation differ between them: let the next sync read it` }
  return { tactic, costType: pays }
}

/** Why nothing is created in this SD campaign, or null. */
function sdCampaignRefusal(c: SdCampaignRow, what: string): string | null {
  if (String(c.status) === 'ARCHIVED') return `campaign "${c.name}" is archived: Amazon serves nothing of it again, so ${what}`
  if (!c.externalCampaignId) return `campaign "${c.name}" is not at Amazon (a draft, or a create Amazon refused), so ${what} could not reach Amazon either`
  if (!c.marketplace) return `campaign "${c.name}" names no market, so ${what}`
  return null
}

const SD_GROUP_INPUT = z.object({
  campaignId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(128),
  defaultBidCents: z.coerce.number().int().min(2).max(100_000),
  bidOptimization: z.enum(SD_BID_OPTIMIZATIONS).optional(),
  creativeType: z.enum(SD_CREATIVE_TYPES).optional(),
  skus: z.array(z.string().trim().min(1).max(64)).max(SD_LIST_MAX).optional(),
  sdTargets: z.array(SD_TARGET_ARG).max(SD_LIST_MAX).optional(),
  includeOutOfStock: z.boolean().optional(),
  why: z.string().trim().max(300).optional(),
})

/** The SP-only arguments of create-ad-group: given for an SD campaign, refused rather than dropped. */
const SP_GROUP_ONLY = ['keywords', 'productTargets', 'negativeKeywords', 'negativeAsins', 'startLive'] as const

/** What an SD ad group's undo and approval-status read (create-ad-group's own `after`, its start always as planned). */
export interface SdGroupAfter { adGroupId: string; campaignId: string; name: string; start: 'live'; productAdIds: string[]; targetIds: string[]; negativeIds: string[] }

/** create-ad-group's dry run for an SD campaign. */
export async function sdGroupPreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>, opts: { tool: string; limits: z.ZodObject; undoNote: string }): Promise<ToolResult> {
  const spOnly = SP_GROUP_ONLY.filter((k) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).length > 0 : raw[k] === true))
  if (spOnly.length) return { ok: false, error: `Not queued: ${spOnly.join(', ')} ${spOnly.length === 1 ? 'is' : 'are'} for a Sponsored Products ad group. A Sponsored Display ad group takes sdTargets (product, category, similar products, views, purchases, audience); negatives go in with add-negative-targets afterwards, and its bids serve as planned once its campaign is on.` }
  const parsed = SD_GROUP_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: issues(parsed.error) }
  const a = parsed.data
  const c = await sdCampaignOf(a.campaignId)
  if (!c) return { ok: false, error: `Campaign ${a.campaignId} not found in this business.` }
  const refused = sdCampaignRefusal(c, 'no ad group is added to it')
  if (refused) return { ok: false, error: `Not queued: ${refused}.` }
  const how = tacticAndPays(c)
  if ('refusal' in how) return { ok: false, error: `Not queued: ${how.refusal}.` }
  const market = c.marketplace!
  const badName = campaignNameProblem(a.name)
  if (badName) return { ok: false, error: `Not queued: ${badName}` }
  const taken = await adGroupNamedInCampaign(c.id, a.name)
  if (taken) return { ok: false, error: `Campaign "${c.name}" already has an ad group named "${taken.name}" (${taken.id}): give the new one another name.` }
  const currency = c.dailyBudgetCurrency?.trim() || 'EUR'
  const group = await groupPlanOf({
    market, currency, tactic: how.tactic, costType: how.costType, name: a.name, defaultBidCents: a.defaultBidCents,
    bidOptimization: a.bidOptimization, creativeType: a.creativeType, skus: a.skus ?? [], sdTargets: a.sdTargets ?? [], includeOutOfStock: a.includeOutOfStock !== false,
  })
  if ('refusal' in group) return { ok: false, error: group.refusal }
  const plan = group.plan
  // The same product twice in one campaign would bid against itself (isolation is per product): refused.
  const same = await sameInCampaign(c.id, plan.products)
  if (same.length) return { ok: false, error: `Not queued: the same product twice in one campaign would bid against itself — ${named(same)} of campaign "${c.name}".` }
  const highest = Math.max(plan.defaultBidCents, ...plan.targets.map((t) => t.bidCents))
  const budgetCents = Math.round(Number(c.dailyBudget) * 100)
  if (how.costType === 'cpc' && highest > budgetCents) return { ok: false, error: `A bid of ${amountLabel(highest, currency)} is above campaign "${c.name}"'s daily budget of ${amountLabel(budgetCents, currency)}: Amazon refuses it.` }
  const reached = await sdReach(market, highest)
  if ('refusal' in reached) return { ok: false, error: reached.refusal }
  const rule = await ruleFactsFor({
    tool: opts.tool, limits: opts.limits, writes: [], approvalId: ctx.approvalId ?? null,
    items: [{ entity: { kind: 'campaign', id: c.id }, change: { field: 'bid', fromCents: null, toCents: plan.defaultBidCents } }],
  })
  const on = String(c.status) === 'ENABLED'
  const startWords = on
    ? `Its campaign is ON: the ad group serves at its bids as soon as Amazon takes it — it SPENDS MONEY from the start (within the campaign's daily budget of ${amountLabel(budgetCents, currency)}).`
    : `Its campaign is ${String(c.status).toLowerCase()}: nothing of it serves until a person switches the campaign on (enable-ads, which SPENDS MONEY).`
  const effect = `Creates ${groupWords(plan, currency, how.costType)} in the Sponsored Display campaign "${c.name}" (${market}, ${TACTIC_WORDS[how.tactic]}). ${startWords}`
    + (group.leftOut.length ? ` Left out, as asked (out of stock): ${named(group.leftOut)}.` : '')
  const raises = on ? [`${plural(plan.products.length, 'product ad')} and ${plural(plan.targets.length, 'target')} serving at their bids (the highest ${amountLabel(highest, currency)})`] : []
  return {
    ok: true,
    preview: {
      action: opts.tool,
      adProduct: 'SD',
      campaign: { id: c.id, name: c.name, marketplace: market, status: String(c.status), tactic: how.tactic, costType: how.costType },
      currency,
      plan: { ...plan, campaign: { id: c.id, name: c.name, marketplace: market }, currency, start: 'live' },
      totals: { productAds: plan.products.length, targets: plan.targets.length },
      highestPlannedBidCents: highest,
      products: productLines(plan.products, group.stock),
      ...(plan.products.length > LINES_SHOWN ? { moreProducts: plan.products.length - LINES_SHOWN } : {}),
      outOfStock: { count: group.stock.filter((s) => !s.inStock).length, note: 'Out-of-stock products are advertised on purpose (Owner 2026-10-20): an ad costs nothing while Amazon cannot sell the product, and serves once stock is back.' },
      ...(group.leftOut.length ? { leftOut: group.leftOut } : {}),
      changes: targetLines(plan.targets, currency, how.costType).slice(0, LINES_SHOWN),
      ...(plan.targets.length > LINES_SHOWN ? { moreChanges: plan.targets.length - LINES_SHOWN } : {}),
      raises,
      spendsMoney: spendsWords(on ? 'at once — its campaign is on.' : 'when its campaign is switched on (enable-ads).'),
      // An ad group that serves at once is a new structure going live (the Owner's code rule, ads-code-rule.ts).
      ...(on && needsCode('create-ad-group: startLive')
        ? { stepUp: { what: `starts a new Sponsored Display ad group spending (${plural(plan.products.length, 'product ad')}, ${plural(plan.targets.length, 'target')})`, raises: ['Product ads', 'Bids', 'Spend'], needs: STEP_UP_NEEDS, how: 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in Claude with theirs.' } }
        : { noCode: on ? DAY_TO_DAY_NO_CODE : 'Its campaign is not on: it adds no spend until a person switches it on, so approving needs no authenticator code.' }),
      liveWrites: c.liveBidWritesEnabled,
      basis: hash({ plan, campaign: [c.id, String(c.status), c.tactic, c.costType], same }),
      reach: reached.reach,
      reachNote: reachNote(reached.reach),
      effect,
      undoNote: opts.undoNote,
      ...rule,
    },
  }
}

/** The SKUs of these products already advertised in this campaign (any ad group, not archived). */
async function sameInCampaign(campaignId: string, products: readonly SdProduct[]): Promise<string[]> {
  if (!products.length) return []
  const ads = await prisma.adProductAd.findMany({
    where: { adGroup: { campaignId }, status: { not: 'ARCHIVED' }, OR: [{ productId: { in: products.map((p) => p.productId) } }, { asin: { in: products.map((p) => p.asin) } }] },
    select: { productId: true, asin: true },
  })
  return products.filter((p) => ads.some((ad) => ad.productId === p.productId || ad.asin === p.asin)).map((p) => `${p.sku} is already advertised there`)
}

/** create-ad-group's run for an SD campaign. */
export async function sdGroupRun(args: Record<string, unknown>, ctx: ToolContext, opts: { tool: string; limits: z.ZodObject; undoNote: string }): Promise<ToolResult> {
  const fresh = await sdGroupPreview(args, ctx, opts)
  const refusal = recheck(ctx, fresh, ['basis', 'reach'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { plan: SdGroupPlan & { campaign: { id: string } }; reach: StoredReach; effect: string }
  const run = approvedRun(ctx, String(args.why ?? '').trim() || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const gate = await codeGate(ctx, fresh.preview)
  if ('refusal' in gate) return notRun(gate.refusal)
  const plan = p.plan
  const { createAdGroupLocal } = await import('../../advertising/ads-create.service.js')
  const common = { userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, requireAmazon: true }
  const group = await createAdGroupLocal({ campaignId: plan.campaign.id, name: plan.name, defaultBidEur: plan.defaultBidCents / 100, sdBidOptimization: plan.bidOptimization, sdCreativeType: plan.creativeType, ...common })
  if (!group.id) return notRun(`Not run: Amazon did not take the ad group — ${group.reason ?? group.notSent?.reason ?? 'no reason given'}. Nothing was created.`)
  const made = await createInGroup(group.id, plan, common)
  const after: SdGroupAfter = { adGroupId: group.id, campaignId: plan.campaign.id, name: plan.name, start: 'live', productAdIds: made.productAds, targetIds: made.targets, negativeIds: [] }
  const change = { before: { changeSetId: run.changeSetId, adGroupId: null }, after }
  const data = {
    adGroupId: group.id, externalAdGroupId: group.externalAdGroupId, campaignId: plan.campaign.id,
    created: { productAds: made.productAds.length, targets: made.targets.length, negatives: 0 }, reach: p.reach, changeSetId: run.changeSetId,
  }
  if (made.failed.length) {
    return { ok: true, data: { ...data, partial: true, notCreated: made.failed.slice(0, LINES_SHOWN), note: `Created part-way: ${plural(made.failed.length, 'row')} did not reach Amazon — ${named(made.failed)}. The ad group "${plan.name}" (${group.id}) holds what was made; check it with ad-groups before asking for more. Undo archives it (archive-ads).` }, change }
  }
  return { ok: true, data, change }
}

// ── add-product-ads, into an SD ad group ──────────────────────────────────────────────────────────

/** An SD ad group as add-product-ads and add-ad-targets read it (from its lookup service), with its campaign's tactic and cost type. */
export interface SdGroupRow { id: string; name: string; status: unknown; defaultBidCents: number; externalAdGroupId: string | null; orphanedAt: Date | null; campaignId: string }

async function sdPlaceOf(g: SdGroupRow, what: string): Promise<{ campaign: SdCampaignRow; tactic: Tactic; costType: CostType } | { refusal: string }> {
  const c = await sdCampaignOf(g.campaignId)
  if (!c) return { refusal: `Not queued: the campaign of ad group "${g.name}" was not found.` }
  const cannot = sdCampaignRefusal(c, what)
    ?? (String(g.status) === 'ARCHIVED' ? `ad group "${g.name}" is archived: Amazon serves it no more` : null)
    ?? (!g.externalAdGroupId ? `ad group "${g.name}" is not at Amazon, so nothing could reach Amazon` : null)
    ?? (g.orphanedAt ? `Amazon no longer has ad group "${g.name}" (Nexus marked it gone)` : null)
  if (cannot) return { refusal: `Not queued: ${cannot}.` }
  const how = tacticAndPays(c)
  if ('refusal' in how) return { refusal: `Not queued: ${how.refusal}.` }
  return { campaign: c, ...how }
}

const SD_ADS_INPUT = z.object({
  adGroupId: z.string().trim().min(1).max(64),
  skus: z.array(z.string().trim().min(1).max(64)).min(1).max(SD_LIST_MAX),
  includeOutOfStock: z.boolean().optional(),
  why: z.string().trim().max(300).optional(),
})

/** add-product-ads' dry run for an SD ad group. */
export async function sdAdsPreview(raw: Record<string, unknown>, g: SdGroupRow, ctx: Pick<ToolContext, 'approvalId'>, opts: { tool: string; limits: z.ZodObject }): Promise<ToolResult> {
  const parsed = SD_ADS_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: issues(parsed.error) }
  const a = parsed.data
  const repeated = a.skus.filter((sku, i) => a.skus.findIndex((x) => x.toLowerCase() === sku.toLowerCase()) !== i)
  if (repeated.length) return { ok: false, error: `Listed twice: ${named([...new Set(repeated)], 5)}.` }
  const place = await sdPlaceOf(g, 'no product ad is added to it')
  if ('refusal' in place) return { ok: false, error: place.refusal }
  const c = place.campaign
  const market = c.marketplace!
  const found = await sdProductsOf(a.skus, market)
  if ('refusal' in found) return { ok: false, error: found.refusal }
  const kept = keptProducts(found, a.includeOutOfStock !== false)
  if (!kept.products.length) return { ok: false, error: `Not queued: every product named is out of stock (${named(kept.leftOut)}) and includeOutOfStock is false: nothing to add.` }
  const same = await sameInCampaign(c.id, kept.products)
  if (same.length) return { ok: false, error: `Not queued: the same product twice in one campaign would bid against itself — ${named(same)} of campaign "${c.name}".` }
  const reached = await sdReach(market, 0)
  if ('refusal' in reached) return { ok: false, error: reached.refusal }
  const currency = c.dailyBudgetCurrency?.trim() || 'EUR'
  const rule = await ruleFactsFor({
    tool: opts.tool, limits: opts.limits, writes: [], approvalId: ctx.approvalId ?? null, projectMonth: true,
    items: kept.products.map((): KitItem => ({ entity: { kind: 'adGroup', id: g.id }, change: { field: 'status', from: null, to: 'ENABLED' } })),
  })
  const on = String(c.status) === 'ENABLED' && String(g.status) === 'ENABLED'
  const effect = `Adds ${plural(kept.products.length, 'product ad')} to the Sponsored Display ad group "${g.name}" (campaign "${c.name}", ${market}): ${named(kept.products.map((p) => p.sku), 5)}, by seller SKU. `
    + (on ? `They serve at its bids (default ${amountLabel(g.defaultBidCents, currency)}): spend starts with them.` : `Its campaign or ad group is not on: they serve once a person switches it on.`)
    + (kept.leftOut.length ? ` Left out, as asked (out of stock): ${named(kept.leftOut)}.` : '')
  return {
    ok: true,
    preview: {
      action: opts.tool,
      adProduct: 'SD',
      campaign: { id: c.id, name: c.name, marketplace: market },
      adGroup: { id: g.id, name: g.name, defaultBidCents: g.defaultBidCents },
      currency,
      products: kept.products.map((p) => ({ sku: p.sku, asin: p.asin, adSku: p.adSku, productId: p.productId })),
      productLines: productLines(kept.products, kept.stock),
      outOfStock: { count: kept.stock.filter((s) => !s.inStock).length, note: 'Out-of-stock products are advertised on purpose (Owner 2026-10-20): an ad costs nothing while Amazon cannot sell the product, and serves once stock is back.' },
      ...(kept.leftOut.length ? { leftOut: kept.leftOut } : {}),
      totals: { productAds: kept.products.length },
      raises: on ? kept.products.map((p) => `the ad of ${p.sku}: it serves at the ad group's bids`) : [],
      spendsMoney: spendsWords(on ? 'at once — its campaign and ad group are on.' : 'when its campaign and ad group are on.'),
      ...(on && needsCode('add-product-ads')
        ? { stepUp: { what: `adds ${plural(kept.products.length, 'product ad')} that serve at the ad group's bids`, raises: ['Product ads', 'Spend'], needs: STEP_UP_NEEDS, how: 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in Claude with theirs.' } }
        : { noCode: on ? DAY_TO_DAY_NO_CODE : 'It adds no spend until a person switches its campaign on: approving needs no authenticator code.' }),
      liveWrites: c.liveBidWritesEnabled,
      basis: hash({ adGroup: [g.id, String(g.status), g.defaultBidCents, String(c.status)], products: kept.products, same }),
      reach: reached.reach,
      reachNote: reachNote(reached.reach),
      effect,
      undoNote: 'Undo pauses these product ads (pause-ads): they stop serving; Amazon keeps them, paused.',
      ...rule,
    },
  }
}

/** add-product-ads' run for an SD ad group: the change record add-product-ads keeps (its undo pauses them). */
export async function sdAdsRun(args: Record<string, unknown>, g: SdGroupRow, ctx: ToolContext, opts: { tool: string; limits: z.ZodObject }): Promise<ToolResult> {
  const fresh = await sdAdsPreview(args, g, ctx, opts)
  const refusal = recheck(ctx, fresh, ['basis', 'reach'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { products: SdProduct[]; reach: StoredReach; effect: string }
  const run = approvedRun(ctx, String(args.why ?? '').trim() || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const gate = await codeGate(ctx, fresh.preview)
  if ('refusal' in gate) return notRun(gate.refusal)
  const made = await createInGroup(g.id, { products: p.products, targets: [] }, { userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, requireAmazon: true })
  if (!made.productAds.length) return notRun(`Not run: Amazon took none of the product ads — ${named(made.failed)}. Nothing was created.`)
  const rows = await prisma.adProductAd.findMany({ where: { id: { in: made.productAds } }, select: { id: true, sku: true, asin: true, status: true } })
  const productAds = rows.map((r) => ({ productAdId: r.id, sku: r.sku ?? r.asin ?? '', status: String(r.status) }))
  const change = { before: { changeSetId: run.changeSetId, adGroupId: g.id, productAds: [] }, after: { adGroupId: g.id, productAds } }
  const data = { adGroupId: g.id, created: productAds.length, productAds, reach: p.reach, changeSetId: run.changeSetId }
  if (made.failed.length) return { ok: true, data: { ...data, partial: true, notCreated: made.failed.slice(0, LINES_SHOWN), note: `Added part-way: ${plural(made.failed.length, 'product ad')} did not reach Amazon — ${named(made.failed)}.` }, change }
  return { ok: true, data, change }
}

// ── add-ad-targets, into an SD ad group ───────────────────────────────────────────────────────────

const SD_TARGETS_INPUT = z.object({
  adGroupId: z.string().trim().min(1).max(64),
  sdTargets: z.array(SD_TARGET_ARG).min(1, 'name the targets to add (sdTargets)').max(SD_LIST_MAX),
  bidCents: z.coerce.number().int().min(2).max(100_000).optional(),
  why: z.string().trim().max(300).optional(),
})

/** The SP-only arguments of add-ad-targets: given for an SD ad group, refused rather than dropped. */
const SP_TARGETS_ONLY = ['keywords', 'productTargets', 'categoryTargets', 'startAtFloor', 'sameProductTerms'] as const

/** add-ad-targets' dry run for an SD ad group; `targets` are what `execute` creates, exactly as approved. */
export async function sdTargetsPreview(raw: Record<string, unknown>, g: SdGroupRow, ctx: Pick<ToolContext, 'approvalId'>, opts: { tool: string; limits: z.ZodObject }): Promise<ToolResult> {
  const spOnly = SP_TARGETS_ONLY.filter((k) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).length > 0 : raw[k] != null))
  if (spOnly.length) return { ok: false, error: `Not queued: ${spOnly.join(', ')} ${spOnly.length === 1 ? 'is' : 'are'} for a Sponsored Products ad group. A Sponsored Display ad group takes sdTargets (product, category, similar products, views, purchases, audience), each at its bid; it has no keywords.` }
  const parsed = SD_TARGETS_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: issues(parsed.error) }
  const a = parsed.data
  const place = await sdPlaceOf(g, 'no target is added to it')
  if ('refusal' in place) return { ok: false, error: place.refusal }
  const c = place.campaign
  const market = c.marketplace!
  const currency = c.dailyBudgetCurrency?.trim() || 'EUR'
  const fallback = a.bidCents ?? g.defaultBidCents
  const planned = plannedTargetsOf(a.sdTargets, { currency, defaultBidCents: fallback, tactic: place.tactic })
  if ('refusal' in planned) return { ok: false, error: planned.refusal }
  const targets = planned.targets
  for (const cents of [...new Set(targets.map((t) => t.bidCents))]) {
    const wrong = bidRefusal(market, place.costType, cents)
    if (wrong) return { ok: false, error: `Not queued: ${wrong}` }
  }
  // Already in this ad group (enabled, paused, archived or only in Nexus): the create would find that row and write nothing.
  const existing = await prisma.adTarget.findMany({ where: { adGroupId: g.id, isNegative: false }, select: { kind: true, expressionValue: true, status: true, externalTargetId: true } })
  const dupes = targets.flatMap((t) => {
    const there = existing.find((e) => String(e.kind) === t.kind && e.expressionValue.toLowerCase() === t.value.toLowerCase())
    if (!there) return []
    const state = String(there.status) === 'ARCHIVED' ? 'archived (Amazon never switches it on again)' : !there.externalTargetId ? 'in Nexus only (it never reached Amazon)' : String(there.status).toLowerCase()
    return [`${t.words} is already in this ad group, ${state}`]
  })
  if (dupes.length) return { ok: false, error: `Not queued: ${named(dupes)}.` }
  const highest = Math.max(...targets.map((t) => t.bidCents))
  const reached = await sdReach(market, highest)
  if ('refusal' in reached) return { ok: false, error: reached.refusal }
  const rule = await ruleFactsFor({
    tool: opts.tool, limits: opts.limits, writes: [], approvalId: ctx.approvalId ?? null,
    items: targets.map((t): KitItem => ({ entity: { kind: 'adGroup', id: g.id }, change: { field: 'bid', fromCents: null, toCents: t.bidCents } })),
  })
  const on = String(c.status) === 'ENABLED' && String(g.status) === 'ENABLED'
  const lines = targetLines(targets, currency, place.costType)
  const counts = { contextual: targets.filter((t) => t.contextual).length, audiences: targets.filter((t) => !t.contextual).length }
  const effect = `Adds ${plural(targets.length, 'target')} to the Sponsored Display ad group "${g.name}" (campaign "${c.name}", ${market}): ${named(lines.map((l) => `${l.label} ${l.toLabel}`))}. `
    + (on ? `They serve at their bids at once (the highest ${amountLabel(highest, currency)}): spend starts with them.` : 'Its campaign or ad group is not on: they serve once a person switches it on.')
  return {
    ok: true,
    preview: {
      action: opts.tool,
      adProduct: 'SD',
      adGroup: { id: g.id, name: g.name },
      campaign: { id: c.id, name: c.name, marketplace: market, tactic: place.tactic, costType: place.costType },
      currency,
      targets,
      totals: { targets: targets.length, ...counts },
      changes: lines.slice(0, LINES_SHOWN),
      ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
      raises: on ? lines.map((l) => `${l.label} ${l.toLabel}`) : [],
      spendsMoney: spendsWords(on ? 'at once — its campaign and ad group are on.' : 'when its campaign and ad group are on.'),
      // New targets serving at their bids: add-ad-targets' own line of the Owner's code rule (ads-code-rule.ts).
      ...(on && needsCode('add-ad-targets: at a bid')
        ? { stepUp: { what: `adds ${plural(targets.length, 'target')} that start spending at their bids`, raises: ['Bids', 'Spend'], needs: STEP_UP_NEEDS, how: 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in Claude with theirs.' } }
        : { noCode: on ? DAY_TO_DAY_NO_CODE : 'It adds no spend until a person switches its campaign on: approving needs no authenticator code.' }),
      highestBidCents: highest,
      // add-ad-targets' own rule check reads it: an SD target is never another ad group's "same product" term.
      sameProductClashes: [],
      basis: hash({ adGroup: [g.id, String(g.status), String(c.status)], targets: targets.map((t) => [t.kind, t.audienceType, t.value, t.bidCents]) }),
      reach: reached.reach,
      reachNote: reachNote(reached.reach),
      effect,
      undoNote: 'Undo pauses each target it added (pause-ads): they stay at Amazon, paused; archive-ads removes them for good.',
      ...rule,
    },
  }
}

/** add-ad-targets' run for an SD ad group: the change record add-ad-targets keeps, marked SD (its undo pauses them). */
export async function sdTargetsRun(args: Record<string, unknown>, g: SdGroupRow, ctx: ToolContext, opts: { tool: string; limits: z.ZodObject }): Promise<ToolResult> {
  const fresh = await sdTargetsPreview(args, g, ctx, opts)
  const refusal = recheck(ctx, fresh, ['basis', 'reach'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { targets: SdPlannedTarget[]; reach: StoredReach; effect: string }
  const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const gate = await codeGate(ctx, fresh.preview)
  if ('refusal' in gate) return notRun(gate.refusal)
  const made = await createInGroup(g.id, { products: [], targets: p.targets }, { userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, requireAmazon: true })
  if (!made.targets.length) return notRun(`Not run: no target was added — ${named(made.failed)}. Nothing changed.`)
  const rows = await prisma.adTarget.findMany({ where: { id: { in: made.targets } }, select: { id: true, bidCents: true, externalTargetId: true, expressionValue: true } })
  return {
    ok: true,
    data: {
      added: rows.length,
      reachedAmazon: rows.filter((r) => r.externalTargetId).length,
      ...(made.failed.length ? { partial: true, failed: made.failed.length, problems: made.failed.slice(0, LINES_SHOWN), problem: `Added ${rows.length} of ${p.targets.length}: ${named(made.failed)}. The rest was not added; ask for it again once that is fixed.` } : {}),
      targets: rows.slice(0, LINES_SHOWN).map((r) => ({ targetId: r.id, target: p.targets.find((t) => t.value.toLowerCase() === r.expressionValue.toLowerCase())?.words ?? r.expressionValue, bidCents: r.bidCents })),
      reach: p.reach,
      changeSetId: run.changeSetId,
      note: p.reach.reach === 'live' ? 'Created at Amazon at once (no cancel window).' : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
    },
    change: {
      before: { changeSetId: run.changeSetId, adGroupId: g.id, adProduct: 'SD', targets: [], added: p.targets.map((t) => ({ kind: t.kind, value: t.value, words: t.words, bidCents: t.bidCents })) },
      after: { targets: rows.map((r) => ({ targetId: r.id, bidCents: r.bidCents })) },
    },
  }
}
