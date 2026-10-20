/**
 * SD-AUD (2026-10-20) — Amazon's own Sponsored Display suggestions, read only (SD 3.0 openapi):
 *
 *   POST /sd/targets/recommendations       what to target for some ASINs — products (ranked, by the advertised ASIN they
 *                                          fit; with contextual themes: higher price, same brand, lower rating, more
 *                                          page views), categories (id, name, path, how many ASINs) and, for tactic
 *                                          T00030, Amazon audiences. v3.4 (v3.5 is a US-only preview). `locale` names
 *                                          the categories in the market's language.
 *   POST /sd/targets/bid/recommendations   a bid range and a recommended bid for up to 100 targeting clauses, for the
 *                                          advertised ASINs, cost type, bid optimization and creative type (v3.3; the
 *                                          last 7 days of winning bids). 207: one answer per clause, in order, each a
 *                                          bid or Amazon's own `code` + `details`.
 *
 * Both are POSTs that change nothing: listed as reads for the gateway and the quota (gateway/ads.ts ADS_READ_POSTS,
 * ads-api-client.ts ADS_READ_ONLY_POSTS). Amounts are in the profile's currency units, as Amazon sends them.
 */
import { adsMode, liveCall, type ClientContext } from '../ads-api-client.js'
import type { SdExpressionJson } from './sd-entities.client.js'

const TARGETS_MIME = 'application/vnd.sdtargetingrecommendations.v3.4+json'
const BIDS_MIME = 'application/vnd.sdtargetingrecommendations.v3.3+json'

export type SdTactic = 'T00020' | 'T00030'
export type SdRecommendationType = 'PRODUCT' | 'CATEGORY' | 'AUDIENCE'
/** Amazon's contextual targeting themes (SDProductTargetingThemeExpression). */
export type SdThemeType = 'asinPriceGreaterThan' | 'asinBrandSameAs' | 'asinReviewRatingLessThan' | 'asinGlanceViewsGreaterThan'

export interface SdProductRecommendation { asin: string; rank: number | null; advertisedAsins: string[] }
export interface SdCategoryRecommendation {
  categoryId: string; name: string | null; path: string[]; asinCount: { from: number | null; to: number | null } | null; rank: number | null
}
export interface SdAudienceRecommendation { audienceId: string; name: string | null; category: string | null; rank: number | null }
export interface SdThemeRecommendation { name: string; code: string | null; expression: unknown; products: SdProductRecommendation[] }
export interface SdTargetingRecommendations {
  products: SdProductRecommendation[]
  categories: SdCategoryRecommendation[]
  audiences: SdAudienceRecommendation[]
  themes: SdThemeRecommendation[]
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** Product recommendations: the reference nests them (`[{ products: [...] }]`), Amazon's samples list them flat. */
function productsOf(list: unknown): SdProductRecommendation[] {
  const out: SdProductRecommendation[] = []
  for (const raw of Array.isArray(list) ? list : []) {
    const p = obj(raw)
    if (Array.isArray(p.products)) { out.push(...productsOf(p.products)); continue }
    const asin = str(p.asin)
    if (asin) out.push({ asin, rank: num(p.rank), advertisedAsins: Array.isArray(p.advertisedAsins) ? p.advertisedAsins.map(String) : [] })
  }
  return out
}

export async function sdTargetingRecommendations(ctx: ClientContext, r: {
  tactic: SdTactic; asins: readonly string[]; types: readonly SdRecommendationType[]
  themes?: ReadonlyArray<{ name: string; type: SdThemeType }>; locale?: string
}): Promise<SdTargetingRecommendations> {
  if (adsMode() === 'sandbox') return { products: [], categories: [], audiences: [], themes: [] }
  const res = await liveCall<{ recommendations?: Record<string, unknown> }>({
    profileId: ctx.profileId, region: ctx.region, method: 'POST',
    path: `/sd/targets/recommendations${r.locale ? `?locale=${r.locale}` : ''}`,
    body: {
      tactic: r.tactic, products: r.asins.map((asin) => ({ asin })), typeFilter: [...r.types],
      ...(r.themes?.length ? { themes: { product: r.themes.map((t) => ({ name: t.name, expression: [{ type: t.type }] })) } } : {}),
    },
    contentType: TARGETS_MIME, acceptHeader: TARGETS_MIME,
  })
  const rec = obj(res?.recommendations)
  const categories: SdCategoryRecommendation[] = []
  for (const raw of Array.isArray(rec.categories) ? rec.categories : []) {
    const c = obj(raw)
    const categoryId = str(c.category)
    if (!categoryId) continue
    const range = obj(c.targetableAsinCountRange)
    const path = Array.isArray(c.translatedPath) ? c.translatedPath : Array.isArray(c.path) ? c.path : []
    categories.push({
      categoryId, name: str(c.translatedName) ?? str(c.name), path: path.map(String),
      asinCount: c.targetableAsinCountRange ? { from: num(range.rangeLower), to: num(range.rangeUpper) } : null, rank: num(c.rank),
    })
  }
  const audiences: SdAudienceRecommendation[] = []
  for (const raw of Array.isArray(rec.audiences) ? rec.audiences : []) {
    const group = obj(raw)
    for (const a of Array.isArray(group.audiences) ? group.audiences : []) {
      const id = str(obj(a).audience)
      if (id) audiences.push({ audienceId: id, name: str(obj(a).name), category: str(group.category), rank: num(obj(a).rank) })
    }
  }
  const themes: SdThemeRecommendation[] = []
  for (const raw of Array.isArray(obj(obj(rec.themes).themes).products) ? (obj(obj(rec.themes).themes).products as unknown[]) : []) {
    const t = obj(raw)
    themes.push({ name: str(t.name) ?? '', code: str(t.code), expression: t.expression ?? null, products: productsOf(t.recommendations) })
  }
  return { products: productsOf(rec.products), categories, audiences, themes }
}

export interface SdBidRecommendation {
  /** The clause's position in the request. */
  index: number
  ok: boolean
  /** Currency units of the profile, as Amazon sends them. */
  recommended: number | null
  rangeLower: number | null
  rangeUpper: number | null
  /** Amazon's own status and words for a clause it gave no bid for. */
  code: string | null
  details: string | null
}

export async function sdBidRecommendations(ctx: ClientContext, r: {
  asins: readonly string[]; costType: 'cpc' | 'vcpm'; bidOptimization: 'clicks' | 'conversions' | 'reach'; creativeType?: 'IMAGE' | 'VIDEO'
  expressions: readonly SdExpressionJson[]
}): Promise<{ costType: string | null; bidOptimization: string | null; bids: SdBidRecommendation[] }> {
  if (adsMode() === 'sandbox') return { costType: null, bidOptimization: null, bids: [] }
  const res = await liveCall<Record<string, unknown>>({
    profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/sd/targets/bid/recommendations',
    body: {
      products: r.asins.map((asin) => ({ asin })), costType: r.costType, bidOptimization: r.bidOptimization,
      ...(r.creativeType ? { creativeType: r.creativeType } : {}),
      targetingClauses: r.expressions.map((expression) => ({ targetingClause: { expressionType: 'manual', expression } })),
    },
    contentType: BIDS_MIME, acceptHeader: BIDS_MIME,
  })
  const list = Array.isArray(res?.bidRecommendations) ? res.bidRecommendations : []
  const bids = r.expressions.map((_, index): SdBidRecommendation => {
    const b = obj(list[index])
    const recommended = num(b.recommended)
    // A success carries the bids; a failure carries `details` instead (SDTargetingBidRecommendationsResponseItemFailureV31).
    return { index, ok: recommended != null, recommended, rangeLower: num(b.rangeLower), rangeUpper: num(b.rangeUpper), code: str(b.code), details: str(b.details) }
  })
  return { costType: str(res?.costType), bidOptimization: str(res?.bidOptimization), bids }
}
