/**
 * SD-AUD (2026-10-20) — Amazon's category ids for Sponsored Display category targets (`asinCategorySameAs`), found by
 * words, and what a category can be refined by (brands, age ranges, genres).
 *
 *   POST /targetableEntities/list   Amazon's targetable-entities search (TargetableEntities_prod_3p,
 *                                   mime application/vnd.Mindreader.TargetableEntitiesResource.v1+json): adProduct
 *                                   SPONSORED_DISPLAY, `searchQueryFilter` (semantic search, spelling correction, prefix
 *                                   completion), `targetTypeFilter` PRODUCT_CATEGORY (contextual category targets) and
 *                                   PRODUCT_CATEGORY_AUDIENCE (the categories of views / purchases remarketing), `locale`.
 *                                   Each entity: its id, Amazon's name for it, and its path in Amazon's taxonomy.
 *   GET /sp/targets/category/{id}/refinements   the brands (and age ranges, genres) of one category. The SD API has no
 *                                   refinement read of its own; SD's grammar names the same Amazon Ads browse ids
 *                                   ("All IDs passed for category and brand-targeting predicates must be valid IDs in the
 *                                   Amazon Ads browse system"), and Amazon's contextual targeting guide says SD uses "the
 *                                   same grammar as Sponsored Products". So a brand id read here is the value of an SD
 *                                   `asinBrandSameAs` (refinement, or negative brand target). Not yet confirmed by a live
 *                                   SD create: the first one is the proof.
 *
 * Read only, through liveCall (the channel gateway). Sandbox answers nothing.
 */
import { adsMode, liveCall, type ClientContext } from '../ads-api-client.js'

const ENTITIES_MIME = 'application/vnd.Mindreader.TargetableEntitiesResource.v1+json'
const REFINEMENTS_MIME = 'application/vnd.spproducttargetingresponse.v3+json'

export type SdCategoryKind = 'PRODUCT_CATEGORY' | 'PRODUCT_CATEGORY_AUDIENCE'

export interface SdCategory {
  kind: SdCategoryKind
  categoryId: string
  name: string | null
  /** Amazon's path to it, top first ("Product Category" › "Automotive" › "Car Care"). */
  path: string[]
  childCount: number | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)

export async function searchSdCategories(ctx: ClientContext, s: {
  words: string; kinds: readonly SdCategoryKind[]; locale?: string; maxResults: number; nextToken?: string
}): Promise<{ categories: SdCategory[]; nextToken: string | null; total: number | null }> {
  if (adsMode() === 'sandbox') return { categories: [], nextToken: null, total: 0 }
  const res = await liveCall<{ targetableEntities?: Array<Record<string, unknown>>; nextToken?: string; totalResults?: number }>({
    profileId: ctx.profileId, region: ctx.region, method: 'POST', path: '/targetableEntities/list',
    body: {
      adProduct: 'SPONSORED_DISPLAY', searchQueryFilter: s.words, targetTypeFilter: [...s.kinds], maxResults: s.maxResults,
      ...(s.locale ? { locale: s.locale } : {}), ...(s.nextToken ? { nextToken: s.nextToken } : {}),
    },
    contentType: ENTITIES_MIME, acceptHeader: ENTITIES_MIME,
  })
  const categories: SdCategory[] = []
  for (const e of res?.targetableEntities ?? []) {
    const kind = str(e.targetType)
    if (kind !== 'PRODUCT_CATEGORY' && kind !== 'PRODUCT_CATEGORY_AUDIENCE') continue
    // The reference names productCategoryId / productCategoryResolved; the guide's samples show id / resolved.
    const categoryId = str(e.productCategoryId) ?? str(e.id)
    if (!categoryId) continue
    categories.push({
      kind, categoryId,
      name: str(e.productCategoryResolved) ?? str(e.resolved),
      path: Array.isArray(e.path) ? e.path.map((p) => String(p)) : [],
      childCount: typeof e.childCount === 'number' ? e.childCount : null,
    })
  }
  return { categories, nextToken: str(res?.nextToken), total: typeof res?.totalResults === 'number' ? res.totalResults : null }
}

export interface SdRefinements {
  brands: Array<{ id: string; name: string | null }>
  ageRanges: Array<{ id: string; name: string | null }>
  genres: Array<{ id: string; name: string | null }>
}

export async function sdCategoryRefinements(ctx: ClientContext, categoryId: string, locale?: string): Promise<SdRefinements> {
  if (adsMode() === 'sandbox') return { brands: [], ageRanges: [], genres: [] }
  const res = await liveCall<Record<string, unknown>>({
    profileId: ctx.profileId, region: ctx.region, method: 'GET',
    path: `/sp/targets/category/${encodeURIComponent(categoryId)}/refinements${locale ? `?locale=${locale}` : ''}`,
    acceptHeader: REFINEMENTS_MIME,
  })
  const list = (v: unknown) => (Array.isArray(v) ? v : [])
    .map((x) => ({ id: str((x as Record<string, unknown>).id), name: str((x as Record<string, unknown>).translatedName) ?? str((x as Record<string, unknown>).name) }))
    .filter((x): x is { id: string; name: string | null } => x.id != null)
  return { brands: list(res?.brands), ageRanges: list(res?.ageRanges), genres: list(res?.genres) }
}
