/**
 * The products list — ONE implementation behind two routes.
 *
 * `GET /api/products` (the querystring API every existing consumer calls) and
 * `POST /api/products/grid` (the grid's own request, verbatim) both end here. The body of this
 * function is the former route handler moved intact, so the two routes cannot drift: a filter,
 * a roll-up or a column exists for both or for neither.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { allowApiKeyScope } from '../../lib/api-key-hook.js'
import {
  getAvailableFields,
  getFieldDefinition,
} from '../pim/field-registry.service.js'
import {
  buildUploadPlan,
  parseUploadBuffer,
  summarisePlan,
  type PlanRow,
} from '../products/bulk-upload.service.js'
import { parseZipUpload } from '../products/bulk-zip-upload.service.js'
import { auditLogService } from '../audit-log.service.js'
import { idempotencyService } from '../idempotency.service.js'
import { masterPriceService } from '../master-price.service.js'
import { masterContentService } from '../master-content.service.js'
import { applyStockMovement } from '../stock-movement.service.js'
import { listEtag, matches } from '../../utils/list-etag.js'
import { productEventService } from '../product-event.service.js'
import {
  productReadCacheService,
  pickFaceImage,
  FACE_IMAGE_ORDER_BY,
  FACE_IMAGE_SELECT,
} from '../product-read-cache.service.js'
import { deriveFulfillmentMethod } from '../fulfillment-derivation.service.js'
import { computeAvailableToPublish } from '../available-to-publish.service.js'
import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'
import { getPendingMcfReservedByProduct } from '../amazon-mcf.service.js'
import { primaryConnectionIds } from '../connection-resolver.service.js'
import {
  shadowCompareProductRead,
  isShadowEnabled,
} from '../pim/resolver-shadow.js'

let _cacheReady: boolean | null = null
let _cacheReadyAt = 0
/** A rebuild just finished: the next list may read the cache without re-checking. */
export function markCacheReady(): void {
  _cacheReady = true
  _cacheReadyAt = Date.now()
}

export async function isCacheReady(): Promise<boolean> {
  const now = Date.now()
  if (_cacheReady !== null && now - _cacheReadyAt < 60_000) return _cacheReady
  _cacheReady = await prisma.productReadCache
    .count()
    .then((c) => c > 0)
    .catch(() => false)
  _cacheReadyAt = now
  return _cacheReady
}

export interface ProductListQuery {
  page?: string
  limit?: string
  search?: string
  status?: string
  channels?: string
  stockLevel?: string
  sort?: string
  // W5.4 — multi-column sort. Comma-separated `field:dir` pairs:
  //   ?sorts=brand:asc,basePrice:desc,sku:asc
  // When set, takes priority over legacy `sort=`. Each pair is
  // validated against the same field allowlist; unknown fields
  // are silently dropped (no operator wants a 400 because they
  // pasted a stale URL).
  sorts?: string
  // C.2 — new filters
  productTypes?: string
  brands?: string
  // eBay LISTING SHELLS (2026-07-18) — shared-family parents that are
  // extra eBay listings OF an existing product. Hidden by default;
  // pass listingShells=1 (or select the EBAY_LISTING_SHELL type) to show.
  listingShells?: string
  // W2.12 — filter by ProductFamily.id (comma-separated). Layered
  // on top of brands/productTypes; matches *any* of the listed
  // family ids (Prisma `in:`). Pass `families=null` to filter for
  // products with no family attached (the "unfamilied" backlog).
  families?: string
  // W3.9 — filter by WorkflowStage.id (comma-separated). Same
  // 'null' literal convention for the "no stage" bucket.
  workflowStages?: string
  tags?: string
  fulfillment?: string
  marketplaces?: string
  hasPhotos?: string
  hasDescription?: string
  hasBrand?: string
  hasGtin?: string
  driftOnly?: string
  includeCoverage?: string
  includeTags?: string
  // Lazy-load children of this parent. Pass the parent's ID
  // verbatim. Disables the default parentId=null filter.
  parentId?: string
  /** Include a windowed sales roll-up per row (`sales`). Opt-in — costs one extra groupBy. */
  includeSales?: string
  /** Window for `includeSales`, in days. Default 90, clamped 1–365. */
  salesDays?: string
  // P.10 — products that are NOT listed on any of these channels.
  // Comma-separated channel names (AMAZON, EBAY, ...). Used by
  // the "Missing on..." filter chips to surface coverage gaps.
  // Distinct from the positive `channels` filter, which uses
  // syncChannels intent rather than actual ChannelListing
  // presence.
  missingChannels?: string
  // F.1 — soft-delete view. Default (omitted / 'false') returns
  // only active rows (deletedAt IS NULL). 'true' flips to the
  // recycle-bin view: only soft-deleted rows. The /products page
  // uses the latter to render the "Deleted" lens after the
  // operator clicks the bin icon in the page header.
  deleted?: string
  // PN.1 — the products grid's Server-Side Row Model contract. All additive; every one is
  // a filter the /products/next page used to apply in the browser over a 200-row page and
  // can no longer, because the grid now asks the server for blocks.
  //   stockLevels  comma-separated subset of out|low|in. Multi-select OR of the same three
  //                clauses `stockLevel=` applies singly ("low" is 0 < stock <= 5 — flat).
  //   priceMin/priceMax   inclusive bounds on basePrice.
  //   stockMin/stockMax   inclusive bounds on totalStock.
  //   photos=none  products with no photos (the "Needs attention" tile).
  stockLevels?: string
  priceMin?: string
  priceMax?: string
  stockMin?: string
  stockMax?: string
  photos?: string
}

export interface ListProductsOptions {
  /** The caller's If-None-Match check; absent means "always build the body". */
  etagMatches?: (etag: string) => boolean
}

export type ListProductsResult =
  | { status: 304; etag: string }
  | { status: 200; etag: string; body: ProductListBody }

export type ProductListBody = {
  products: any[]
  page: number
  limit: number
  total: number
  totalPages: number
  salesUnattributed: Array<{ channel: string; orders: number; units: number; revenueCents: number }> | null
  stats: { total: number; active: number; draft: number; inStock: number; outOfStock: number }
}

/**
 * WHO is in the list, from the query alone: the Prisma `where` (and its read-cache twin), the
 * paging window, the single-sort `orderBy` and the row-shape flags. Shared by `listProducts` and
 * the grouped path of the grid endpoint, so a group row and a flat row can never disagree about
 * which products a filter admits. Moved out of `listProducts` intact.
 */
/** The literal a "no value" group key travels as — a null brand cannot be a URL value. */
export const NULL_FILTER_VALUE = '__null__'

/**
 * AVAILABLE — the one measure. `Product.totalStock` is a maintained column that is stale in
 * practice (measured 2026-08-28: 0 on 11 of 14 families whose cells show hundreds of units, 10
 * on a standalone product holding 58), and it never includes a family's children. The cell has
 * always shown the stock-LEVEL roll-up — every StockLevel row of the product and of its
 * variations — so that roll-up is what sorting, the stock filters, the KPI counts and the group
 * totals read too. One CTE, used by all of them, so they cannot disagree.
 */
export const stockRollupCte = (ids: readonly string[]): Prisma.Sql => Prisma.sql`
  stockq AS (
    SELECT own.id, COALESCE(SUM(sl.quantity), 0)::float AS qty
    FROM unnest(${[...ids]}::text[]) AS own(id)
    LEFT JOIN "Product" c ON c.id = own.id OR c."parentId" = own.id
    LEFT JOIN "StockLevel" sl ON sl."productId" = c.id
    GROUP BY own.id
  )`

/** Available per product id (self + variations), for a set of ids. */
export async function stockRollup(ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ id: string; qty: number }>>`WITH ${stockRollupCte(ids)} SELECT id, qty FROM stockq`
  return new Map(rows.map((r) => [r.id, Number(r.qty)]))
}

/** The stock predicates a query carries, evaluated against the roll-up rather than the column. */
export interface StockPredicate {
  levels: string[]
  min?: number
  max?: number
}
export const stockMatches = (qty: number, p: StockPredicate): boolean => {
  if (p.min !== undefined && qty < p.min) return false
  if (p.max !== undefined && qty > p.max) return false
  if (p.levels.length === 0) return true
  return (p.levels.includes('in') && qty > 0) || (p.levels.includes('low') && qty > 0 && qty <= 5) || (p.levels.includes('out') && qty === 0)
}

/** Restrict `where` to the ids the roll-up admits. Candidates come from the base scope first. */
async function restrictToStock(where: any, cacheWhere: any, useCache: boolean, p: StockPredicate): Promise<void> {
  const candidates: Array<{ id: string }> = useCache
    ? await prisma.productReadCache.findMany({ where: cacheWhere, select: { id: true } })
    : await prisma.product.findMany({ where, select: { id: true } })
  const qty = await stockRollup(candidates.map((c) => c.id))
  const kept = candidates.map((c) => c.id).filter((id) => stockMatches(qty.get(id) ?? 0, p))
  where.AND = [...((where.AND as any[]) ?? []), { id: { in: kept } }]
  cacheWhere.AND = [...((cacheWhere.AND as any[]) ?? []), { id: { in: kept } }]
}

/**
 * `field IN (...)`, where the list may name the NULL value itself. Grouping by Brand yields a
 * "(no brand)" group; opening it asks for `brands=__null__`, which no `IN` can express.
 */
function applyInOrNull(target: any, field: string, list: string[]): void {
  if (list.length === 0) return
  const values = list.filter((v) => v !== NULL_FILTER_VALUE)
  const wantsNull = values.length !== list.length
  if (!wantsNull) { target[field] = { in: values }; return }
  if (values.length === 0) { target[field] = null; return }
  target.AND = [...(target.AND ?? []), { OR: [{ [field]: null }, { [field]: { in: values } }] }]
}

/**
 * The KPI counts of a scope. Cache counts when the cache can serve the scope — single
 * flat-table COUNTs against 5 × multi-join Product COUNTs.
 */
async function countStatsTuple(scope: { where: any; cacheWhere: any; useCache: boolean }): Promise<[number, number, number, number, number]> {
  const { where, cacheWhere, useCache } = scope
  // In / out of stock are the ROLL-UP's answer: a family with 539 units across its variations
  // is in stock, whatever its own (stale) `totalStock` column says.
  const stockCounts = async (): Promise<[number, number]> => {
    const ids: Array<{ id: string }> = useCache
      ? await prisma.productReadCache.findMany({ where: cacheWhere, select: { id: true } })
      : await prisma.product.findMany({ where, select: { id: true } })
    const qty = await stockRollup(ids.map((r) => r.id))
    let inStock = 0, outOfStock = 0
    for (const r of ids) { if ((qty.get(r.id) ?? 0) > 0) inStock++; else outOfStock++ }
    return [inStock, outOfStock]
  }
  const [total, active, draft, [inStock, outOfStock]] = useCache
    ? await Promise.all([
        prisma.productReadCache.count({ where: cacheWhere }),
        prisma.productReadCache.count({ where: { ...cacheWhere, status: 'ACTIVE' } }),
        prisma.productReadCache.count({ where: { ...cacheWhere, status: 'DRAFT' } }),
        stockCounts(),
      ])
    : await Promise.all([
        prisma.product.count({ where }),
        prisma.product.count({ where: { ...where, status: 'ACTIVE' } }),
        prisma.product.count({ where: { ...where, status: 'DRAFT' } }),
        stockCounts(),
      ])
  return [total, active, draft, inStock, outOfStock]
}

/** The KPI counts for a query — what a grouped level reports beside its group rows. */
export async function countProductStats(q: ProductListQuery): Promise<ProductListBody['stats']> {
  const scope = await resolveProductsScope(q)
  const [total, active, draft, inStock, outOfStock] = await countStatsTuple(scope)
  return { total, active, draft, inStock, outOfStock }
}

export async function resolveProductsScope(q: ProductListQuery) {
  const page = Math.max(parseInt(q.page ?? '1', 10) || 1, 1)
  const limit = Math.max(
    Math.min(parseInt(q.limit ?? '50', 10) || 50, 500),
    1,
  )
  const search = (q.search ?? '').trim()
  const statusList = (q.status ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const channelList = (q.channels ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const productTypeList = (q.productTypes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const brandList = (q.brands ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  // W2.12 — family filter. 'null' literal means "products with no
  // family attached"; otherwise comma-separated family ids.
  const familiesRaw = (q.families ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const familyFilterUnattached = familiesRaw.length === 1 && familiesRaw[0] === 'null'
  const familyIdList = familyFilterUnattached ? [] : familiesRaw
  // W3.9 — workflow-stage filter. Same 'null' convention.
  const wfStagesRaw = (q.workflowStages ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const wfStageFilterUnattached = wfStagesRaw.length === 1 && wfStagesRaw[0] === 'null'
  const wfStageIdList = wfStageFilterUnattached ? [] : wfStagesRaw
  const tagIdList = (q.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const fulfillmentList = (q.fulfillment ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const marketplaceList = (q.marketplaces ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  // P.10 — channels we want products NOT to be listed on. Coverage-gap surface.
  const missingChannelList = (q.missingChannels ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const stockLevel = (q.stockLevel ?? 'all').toLowerCase()
  const sort = q.sort ?? 'updated'
  const includeCoverage = q.includeCoverage === 'true' || q.includeCoverage === '1'
  const includeTags = q.includeTags === 'true' || q.includeTags === '1'
  // Sales roll-up is opt-in and windowed. Off by default so the plain list stays one query.
  const includeSales = q.includeSales === 'true' || q.includeSales === '1'
  const salesDays = Math.min(Math.max(Number(q.salesDays ?? 90), 1), 365)

  // Default scope: top-level rows only. Override with ?parentId=<id>
  // to fetch children of a specific parent (used by the grid's
  // expand-on-chevron flow).
  const where: any = q.parentId ? { parentId: q.parentId } : { parentId: null }
  if (search) {
    where.OR = [
      { sku: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { brand: { contains: search, mode: 'insensitive' } },
      { gtin: { contains: search } },
    ]
  }
  if (statusList.length > 0) {
    where.status = { in: statusList }
  }
  if (channelList.length > 0) {
    where.syncChannels = { hasSome: channelList }
  }
  applyInOrNull(where, 'productType', productTypeList)
  applyInOrNull(where, 'brand', brandList)
  // eBay LISTING SHELLS — extra eBay listings OF an existing product
  // (shared-family siblings). Catalog noise by default: excluded unless
  // the operator asks (listingShells=1) or explicitly selects the type in
  // the facet — complete control through the existing Filters UI.
  const includeListingShells =
    q.listingShells === '1' || q.listingShells === 'true' ||
    productTypeList.includes('EBAY_LISTING_SHELL')
  if (!includeListingShells) {
    where.NOT = [...(Array.isArray(where.NOT) ? where.NOT : where.NOT ? [where.NOT] : []), { productType: 'EBAY_LISTING_SHELL' }]
  }
  // W2.12 — family filter. families=null means "no family attached";
  // otherwise filter by familyId in the list.
  if (familyFilterUnattached) where.familyId = null
  else if (familyIdList.length > 0) where.familyId = { in: familyIdList }
  // W3.9 — workflow-stage filter, same shape.
  if (wfStageFilterUnattached) where.workflowStageId = null
  else if (wfStageIdList.length > 0) where.workflowStageId = { in: wfStageIdList }
  if (fulfillmentList.length > 0) where.fulfillmentMethod = { in: fulfillmentList }
  if (marketplaceList.length > 0) {
    where.channelListings = { some: { marketplace: { in: marketplaceList } } }
  }
  // P.10 — products NOT listed on the given channels. Cleanly
  // composes with the existing marketplace filter via Prisma's
  // implicit AND on `where` keys, except both target the same
  // relation, so we use AND[] when both are set.
  if (missingChannelList.length > 0) {
    const missingClause = {
      channelListings: { none: { channel: { in: missingChannelList } } },
    } as const
    if (where.channelListings) {
      where.AND = [
        ...((where.AND as any[]) ?? []),
        { channelListings: where.channelListings },
        missingClause,
      ]
      delete where.channelListings
    } else {
      where.channelListings = missingClause.channelListings
    }
  }
  if (tagIdList.length > 0) {
    // Filter products that have AT LEAST ONE of the selected tags
    where.id = {
      in: (await prisma.productTag.findMany({
        where: { tagId: { in: tagIdList } },
        select: { productId: true },
        distinct: ['productId'],
      })).map((r) => r.productId),
    }
  }
  if (q.hasPhotos === 'true') where.images = { some: {} }
  if (q.hasPhotos === 'false') where.images = { none: {} }
  // Catalog hygiene tri-states. Treat empty strings as missing
  // (Postgres distinguishes NULL from '', but the operator wants
  // both classes flagged for cleanup). We push these into AND[]
  // rather than touching where.OR — the OR slot is already owned
  // by `search` and combining the two via OR would mix "matches
  // search" with "missing description" semantically.
  const hygieneClauses: any[] = []
  if (q.hasDescription === 'true') {
    hygieneClauses.push({ description: { not: null }, NOT: { description: '' } })
  } else if (q.hasDescription === 'false') {
    hygieneClauses.push({ OR: [{ description: null }, { description: '' }] })
  }
  if (q.hasBrand === 'true') {
    hygieneClauses.push({ brand: { not: null }, NOT: { brand: '' } })
  } else if (q.hasBrand === 'false') {
    hygieneClauses.push({ OR: [{ brand: null }, { brand: '' }] })
  }
  if (q.hasGtin === 'true') {
    hygieneClauses.push({ gtin: { not: null }, NOT: { gtin: '' } })
  } else if (q.hasGtin === 'false') {
    hygieneClauses.push({ OR: [{ gtin: null }, { gtin: '' }] })
  }
  if (hygieneClauses.length > 0) {
    where.AND = [...((where.AND as any[]) ?? []), ...hygieneClauses]
  }
  // Stock predicates are NOT column clauses: they are evaluated against the roll-up once the
  // rest of the scope is known (see `restrictToStock` at the end). The multi-select
  // `stockLevels=` takes precedence over the single `stockLevel=` — the newer caller.
  const stockLevels = (q.stockLevels ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const stockPredicate: StockPredicate = {
    levels: stockLevels.length ? stockLevels.filter((l) => l === 'in' || l === 'low' || l === 'out') : ['in', 'low', 'out'].includes(stockLevel) ? [stockLevel] : [],
  }
  // PN.1 — inclusive ranges. A non-numeric bound is ignored rather than 400'd — the page
  // holds these as free text and an operator mid-keystroke must not lose the grid.
  const num = (v?: string) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : undefined }
  const priceMin = num(q.priceMin), priceMax = num(q.priceMax)
  if (priceMin !== undefined || priceMax !== undefined) {
    where.basePrice = { ...(priceMin !== undefined ? { gte: priceMin } : {}), ...(priceMax !== undefined ? { lte: priceMax } : {}) }
  }
  stockPredicate.min = num(q.stockMin)
  stockPredicate.max = num(q.stockMax)
  // PN.1 — the "Needs attention" tile.
  if ((q.photos ?? '').toLowerCase() === 'none') {
    where.AND = [...((where.AND as any[]) ?? []), { photoCount: 0 }]
  }
  // PN.1 — the grid's "clicked tile excludes every accordion status" case: an empty set,
  // stated as one, rather than a widened result.
  if (q.status === '__none__') where.status = { in: [] }

  // F.1 — soft-delete scope. Default = active only (deletedAt IS
  // NULL); ?deleted=true = recycle bin (deletedAt NOT NULL).
  const showDeleted = q.deleted === 'true' || q.deleted === '1'
  where.deletedAt = showDeleted ? { not: null } : null

  // ES.3 — Build ProductReadCache where + decide whether to use it.
  // Cache can only serve queries that don't need ChannelListing joins
  // (marketplaces= and missingChannels= filters require those).
  const useCacheFilters = marketplaceList.length === 0 && missingChannelList.length === 0
  const useCache = useCacheFilters && (await isCacheReady())

  const cacheWhere: any = q.parentId ? { parentId: q.parentId } : { parentId: null }
  if (useCache) {
    if (search) {
      cacheWhere.OR = [
        { sku: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (statusList.length > 0) cacheWhere.status = { in: statusList }
    if (channelList.length > 0) cacheWhere.syncChannels = { hasSome: channelList }
    applyInOrNull(cacheWhere, 'productType', productTypeList)
    applyInOrNull(cacheWhere, 'brand', brandList)
    // eBay listing shells — mirror the live-table default exclusion.
    if (!includeListingShells) {
      cacheWhere.NOT = [...(Array.isArray(cacheWhere.NOT) ? cacheWhere.NOT : cacheWhere.NOT ? [cacheWhere.NOT] : []), { productType: 'EBAY_LISTING_SHELL' }]
    }
    if (familyFilterUnattached) cacheWhere.familyId = null
    else if (familyIdList.length > 0) cacheWhere.familyId = { in: familyIdList }
    if (wfStageFilterUnattached) cacheWhere.workflowStageId = null
    else if (wfStageIdList.length > 0) cacheWhere.workflowStageId = { in: wfStageIdList }
    if (fulfillmentList.length > 0) cacheWhere.fulfillmentMethod = { in: fulfillmentList }
    // Tag filter produces an id-list subquery above; reuse the result.
    if (tagIdList.length > 0 && where.id) cacheWhere.id = where.id
    // Hygiene flags — direct booleans in cache (no sub-clause needed).
    if (q.hasPhotos === 'true') cacheWhere.hasPhotos = true
    if (q.hasPhotos === 'false') cacheWhere.hasPhotos = false
    if (q.hasDescription === 'true') cacheWhere.hasDescription = true
    if (q.hasDescription === 'false') cacheWhere.hasDescription = false
    if (q.hasBrand === 'true') cacheWhere.hasBrand = true
    if (q.hasBrand === 'false') cacheWhere.hasBrand = false
    if (q.hasGtin === 'true') cacheWhere.hasGtin = true
    if (q.hasGtin === 'false') cacheWhere.hasGtin = false
    // IN.4 — drift filter (any channel override active)
    if (q.driftOnly === 'true') cacheWhere.driftCount = { gt: 0 }
    // Price bounds apply to the cache exactly as to the table; stock is the roll-up (below).
    if (priceMin !== undefined || priceMax !== undefined) {
      cacheWhere.basePrice = { ...(priceMin !== undefined ? { gte: priceMin } : {}), ...(priceMax !== undefined ? { lte: priceMax } : {}) }
    }
    cacheWhere.deletedAt = showDeleted ? { not: null } : null
  }

  const orderBy: any = (() => {
    switch (sort) {
      case 'created':
        return { createdAt: 'desc' }
      case 'sku':
        return { sku: 'asc' }
      case 'name':
        return { name: 'asc' }
      case 'price-asc':
        return { basePrice: 'asc' }
      case 'price-desc':
        return { basePrice: 'desc' }
      case 'stock-asc':
        return { totalStock: 'asc' }
      case 'stock-desc':
        return { totalStock: 'desc' }
      // U.26 — derived-column sorting via Prisma's relation _count.
      // The grid already shows photoCount / channelCount /
      // variantCount per row; without server-side sort an
      // operator click-sorted the visible 100-row page instead
      // of the full filtered catalog, which made "show me the
      // worst" queries impossible past the page boundary.
      //
      // Completeness sort isn't here — it's a CASE-expression
      // sum over 6 fields, which Prisma's orderBy doesn't
      // express natively. Lands in a follow-up using $queryRaw
      // for the order then findMany for the data.
      case 'photos-asc':
        return { images: { _count: 'asc' } }
      case 'photos-desc':
        return { images: { _count: 'desc' } }
      case 'channels-asc':
        return { channelListings: { _count: 'asc' } }
      case 'channels-desc':
        return { channelListings: { _count: 'desc' } }
      case 'variants-asc':
        return { variations: { _count: 'asc' } }
      case 'variants-desc':
        return { variations: { _count: 'desc' } }
      case 'completeness-asc':
      case 'completeness-desc':
        // F.5 / U.29 — completeness is a CASE-expression sum of
        // 6 binary checks (name / brand / productType / photos /
        // channels / tags). Prisma's orderBy can't express that.
        // Handled below: a separate prefetch pass scores every
        // matching row in JS, then we slice to the page and use
        // the resulting id list as the sort key. Returning
        // updatedAt here is just a placeholder — the real sort
        // is applied via where: { id: { in: <sortedSliceIds> } }
        // and a JS re-order after the findMany returns.
        return { updatedAt: 'desc' }
      case 'updated':
      default:
        return { updatedAt: 'desc' }
    }
  })()
  // The roll-up predicates last, over everything the scope already admits.
  const stockActive = stockPredicate.levels.length > 0 || stockPredicate.min !== undefined || stockPredicate.max !== undefined
  if (stockActive) await restrictToStock(where, cacheWhere, useCache, stockPredicate)

  return { page, limit, where, cacheWhere, useCache, orderBy, sort, stockLevel, includeCoverage, includeTags, includeSales, salesDays }
}

export async function listProducts(q: ProductListQuery, opts: ListProductsOptions = {}): Promise<ListProductsResult> {
  const { page, limit, where, cacheWhere, useCache, orderBy, sort, stockLevel, includeCoverage, includeTags, includeSales, salesDays } = await resolveProductsScope(q)

  // W5.4 — Multi-column sort. When `sorts=` is present + parses
  // to at least one valid pair, it overrides the single-sort
  // orderBy above. Field mapping mirrors the single-sort switch
  // for consistency.
  const sortsRaw = (q.sorts ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  type Dir = 'asc' | 'desc'
  const SORT_FIELD_MAP: Record<string, (dir: Dir) => any> = {
    sku:         (dir) => ({ sku: dir }),
    name:        (dir) => ({ name: dir }),
    basePrice:   (dir) => ({ basePrice: dir }),
    price:       (dir) => ({ basePrice: dir }), // alias
    totalStock:  (dir) => ({ totalStock: dir }),
    stock:       (dir) => ({ totalStock: dir }), // alias
    status:      (dir) => ({ status: dir }),
    brand:       (dir) => ({ brand: dir }),
    productType: (dir) => ({ productType: dir }),
    updated:     (dir) => ({ updatedAt: dir }),
    updatedAt:   (dir) => ({ updatedAt: dir }),
    created:     (dir) => ({ createdAt: dir }),
    createdAt:   (dir) => ({ createdAt: dir }),
    photos:      (dir) => ({ images: { _count: dir } }),
    channels:    (dir) => ({ channelListings: { _count: dir } }),
    variants:    (dir) => ({ variations: { _count: dir } }),
  }
  const multiOrderBy: any[] = []
  for (const pair of sortsRaw) {
    const [field, dirRaw] = pair.split(':')
    const dir: Dir = dirRaw === 'desc' ? 'desc' : 'asc'
    const mapper = SORT_FIELD_MAP[field?.trim()]
    if (!mapper) continue // unknown field — silently drop
    multiOrderBy.push(mapper(dir))
  }

  // ES.3 — Cache-native sort map. Counts are stored as columns
  // so no _count magic needed — direct column sort is faster.
  const CACHE_SORT_MAP: Record<string, (dir: Dir) => any> = {
    sku: (dir) => ({ sku: dir }),
    name: (dir) => ({ name: dir }),
    basePrice: (dir) => ({ basePrice: dir }),
    price: (dir) => ({ basePrice: dir }),
    totalStock: (dir) => ({ totalStock: dir }),
    stock: (dir) => ({ totalStock: dir }),
    status: (dir) => ({ status: dir }),
    brand: (dir) => ({ brand: dir }),
    productType: (dir) => ({ productType: dir }),
    updated: (dir) => ({ updatedAt: dir }),
    updatedAt: (dir) => ({ updatedAt: dir }),
    created: (dir) => ({ createdAt: dir }),
    createdAt: (dir) => ({ createdAt: dir }),
    photos: (dir) => ({ photoCount: dir }),
    channels: (dir) => ({ channelCount: dir }),
    variants: (dir) => ({ variantCount: dir }),
  }
  const cacheSingleOrderBy: any = (() => {
    switch (sort) {
      case 'created': return { createdAt: 'desc' }
      case 'sku': return { sku: 'asc' }
      case 'name': return { name: 'asc' }
      case 'price-asc': return { basePrice: 'asc' }
      case 'price-desc': return { basePrice: 'desc' }
      case 'stock-asc': return { totalStock: 'asc' }
      case 'stock-desc': return { totalStock: 'desc' }
      case 'photos-asc': return { photoCount: 'asc' }
      case 'photos-desc': return { photoCount: 'desc' }
      case 'channels-asc': return { channelCount: 'asc' }
      case 'channels-desc': return { channelCount: 'desc' }
      case 'variants-asc': return { variantCount: 'asc' }
      case 'variants-desc': return { variantCount: 'desc' }
      default: return { updatedAt: 'desc' }
    }
  })()
  const cacheMultiOrderBy: any[] = []
  for (const pair of sortsRaw) {
    const [field, dirRaw] = pair.split(':')
    const dir: Dir = dirRaw === 'desc' ? 'desc' : 'asc'
    const cacheMapper = CACHE_SORT_MAP[field?.trim()]
    if (!cacheMapper) continue
    cacheMultiOrderBy.push(cacheMapper(dir))
  }
  const effectiveCacheOrderBy = cacheMultiOrderBy.length > 0 ? cacheMultiOrderBy : cacheSingleOrderBy

  // U.29 — completeness sort prefetch. Score = number of
  // "passes" across 6 hygiene checks; lower score = more
  // missing. Sorting ascending surfaces "what needs work";
  // descending shows the cleanest rows first.
  //
  // Tradeoff: we fetch every matching id+score before slicing,
  // not just the page. On Xavia's 279-row catalog that's
  // negligible (a single _count rollup query under 50ms). At
  // larger catalogs this would need a materialized
  // `completenessScore Int` column updated on PATCH. Comment
  // calls out the threshold so the next operator hitting the
  // wall knows the next step.
  let preorderedIds: string[] | null = null
  if (sort === 'completeness-asc' || sort === 'completeness-desc') {
    const direction = sort === 'completeness-asc' ? 1 : -1
    const start = (page - 1) * limit

    if (useCache) {
      // ES.3 — cache path: hygiene flags + counts are columns, no _count join.
      const candidates = await prisma.productReadCache.findMany({
        where: cacheWhere,
        select: {
          id: true,
          name: true,
          hasBrand: true,
          hasPhotos: true,
          productType: true,
          channelCount: true,
        },
      })
      const scored = candidates.map((p) => {
        const score = [
          !!(p.name && p.name.trim().length > 0 && p.name !== 'Untitled product'),
          p.hasBrand,
          !!p.productType,
          p.hasPhotos,
          p.channelCount > 0,
        ].reduce((n, ok) => n + (ok ? 1 : 0), 0)
        return { id: p.id, score }
      })
      scored.sort((a, b) => (a.score - b.score) * direction)
      preorderedIds = scored.slice(start, start + limit).map((s) => s.id)
    } else {
      const candidates = await prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          brand: true,
          productType: true,
          _count: { select: { images: true, channelListings: true } },
        },
      })
      const scored = candidates.map((p) => {
        const checks = [
          !!(p.name && p.name.trim().length > 0 && p.name !== 'Untitled product'),
          !!p.brand,
          !!p.productType,
          (p._count?.images ?? 0) > 0,
          (p._count?.channelListings ?? 0) > 0,
        ]
        const score = checks.reduce((n, ok) => n + (ok ? 1 : 0), 0)
        return { id: p.id, score }
      })
      scored.sort((a, b) => (a.score - b.score) * direction)
      preorderedIds = scored.slice(start, start + limit).map((s) => s.id)
    }
  }

  // PN.1 — Sales and Units are a windowed roll-up of orders, not a column, so Prisma has
  // nothing to ORDER BY. The filters still decide WHO is in the list (the same `where` as every
  // other sort, so the two cannot disagree); Postgres then does the roll-up, the ordering and
  // the page slice in one statement over that id set. Nothing is sorted in JavaScript, and the
  // window stays a request parameter — a precomputed column would freeze it. A child's orders
  // land on its parent, exactly as the cells are rendered. Ties break on name, then id, so
  // paging is stable. Only the leading sales/units sort is honoured.
  const salesSort = sortsRaw
    .map((pair) => pair.split(':').map((x) => x.trim()))
    .find(([field]) => field === 'sales' || field === 'units')
  // AVAILABLE sorts by the roll-up, never by the stale column — the family preview's
  // `sort=stock-asc` included, so "lowest stock first" means what the cells show.
  const lead = sortsRaw[0]?.split(':').map((x) => x.trim())
  const stockSort: 'asc' | 'desc' | null =
    lead && (lead[0] === 'totalStock' || lead[0] === 'stock') ? (lead[1] === 'desc' ? 'desc' : 'asc')
    : sortsRaw.length === 0 && sort === 'stock-asc' ? 'asc'
    : sortsRaw.length === 0 && sort === 'stock-desc' ? 'desc'
    : null
  if (preorderedIds === null && stockSort) {
    const dir = stockSort === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`
    const candidates: Array<{ id: string }> = useCache
      ? await prisma.productReadCache.findMany({ where: cacheWhere, select: { id: true } })
      : await prisma.product.findMany({ where, select: { id: true } })
    const ordered = candidates.length
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          WITH ${stockRollupCte(candidates.map((c) => c.id))}
          SELECT s.id FROM stockq s JOIN "Product" p ON p.id = s.id
          ORDER BY s.qty ${dir}, p.name ASC, s.id ASC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}
        `
      : []
    preorderedIds = ordered.map((row) => row.id)
  }
  if (preorderedIds === null && salesSort) {
    const metric = salesSort[0] as 'sales' | 'units'
    const dir = salesSort[1] === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`
    const candidates: Array<{ id: string }> = useCache
      ? await prisma.productReadCache.findMany({ where: cacheWhere, select: { id: true } })
      : await prisma.product.findMany({ where, select: { id: true } })
    const since = new Date()
    since.setUTCDate(since.getUTCDate() - salesDays)
    const measure = metric === 'sales'
      ? Prisma.sql`SUM(CASE WHEN o.id IS NULL THEN 0 ELSE oi.quantity * oi.price END)`
      : Prisma.sql`SUM(CASE WHEN o.id IS NULL THEN 0 ELSE oi.quantity END)`
    const ordered = candidates.length
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT own.id
          FROM unnest(${candidates.map((c) => c.id)}::text[]) AS own(id)
          JOIN "Product" p ON p.id = own.id
          LEFT JOIN "Product" c ON c.id = own.id OR c."parentId" = own.id
          LEFT JOIN "OrderItem" oi ON oi."productId" = c.id
          LEFT JOIN "Order" o ON o.id = oi."orderId"
            AND o."createdAt" >= ${since}
            AND o.status <> 'CANCELLED'
          GROUP BY own.id, p.name
          ORDER BY COALESCE(${measure}, 0) ${dir}, p.name ASC, own.id ASC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}
        `
      : []
    preorderedIds = ordered.map((row) => row.id)
  }

  // Phase 10b — short-circuit with 304 when nothing has changed.
  // /products grid polls every 30s + on visibility-change; without
  // ETag every poll re-runs the heavy product list with relations.
  const { etag, count: etagCount } = await listEtag(prisma, {
    model: 'product',
    where,
    filterContext: {
      page,
      limit,
      sort: q.sort,
      includeCoverage,
      includeTags,
      parentId: q.parentId ?? null,
    },
  })
  if (opts.etagMatches?.(etag)) {
    return { status: 304 as const, etag }
  }

  // U.29 / PN.1 — when sorting by completeness or sales, the page slice already
  // resolved into preorderedIds; the findMany targets
  // those ids directly (no take/skip; the slice owned that).
  const preordered = preorderedIds !== null
  const effectiveWhere: any = preordered
    ? { id: { in: preorderedIds } }
    : where
  const effectiveTake = preordered ? undefined : limit
  const effectiveSkip = preordered ? undefined : (page - 1) * limit
  // W5.4 — multi-sort overrides legacy single-sort when present.
  // The pre-ordered path (completeness, sales: prefetch + post-sort) ignores
  // both because it's IN-list-driven; multi-sort here is the
  // preferred Prisma-native path for everything else.
  const effectiveOrderBy = preordered
    ? undefined
    : multiOrderBy.length > 0
      ? multiOrderBy
      : orderBy

  // ES.3 — cache-aware effective where/orderBy for cache path.
  const effectiveCacheWhere: any = preordered
    ? { id: { in: preorderedIds } }
    : cacheWhere

  const rawProductsPromise: Promise<any[]> = useCache
    ? prisma.productReadCache.findMany({
        where: effectiveCacheWhere,
        orderBy: preordered ? undefined : effectiveCacheOrderBy,
        take: effectiveTake,
        skip: effectiveSkip,
      })
    : prisma.product.findMany({
          where: preordered ? { id: { in: preorderedIds } } : where,
          orderBy: effectiveOrderBy,
          take: effectiveTake,
          skip: effectiveSkip,
          select: {
            id: true,
            sku: true,
            name: true,
            brand: true,
            basePrice: true,
            totalStock: true,
            lowStockThreshold: true,
            status: true,
            syncChannels: true,
            updatedAt: true,
            createdAt: true,
            isParent: true,
            parentId: true,
            productType: true,
            fulfillmentMethod: true,
            family: { select: { id: true, code: true, label: true } },
            workflowStage: {
              select: {
                id: true,
                code: true,
                label: true,
                isPublishable: true,
                isTerminal: true,
                workflow: { select: { id: true, code: true, label: true } },
              },
            },
            version: true,
            images: {
              // PG.2 + PG.4 — fetch enough rows to apply the
              // isPrimary → MAIN → sortOrder picker on the read
              // side, matching the cache path. Direct path doesn't
              // carry the parent→child fallback (the cache path
              // does; this path is only used for marketplace /
              // missing-channel filter modes which rarely hit
              // unimaged parents).
              select: FACE_IMAGE_SELECT,
              orderBy: FACE_IMAGE_ORDER_BY,
              take: 12,
            },
            _count: {
              select: { images: true, channelListings: true, variations: true, children: true },
            },
            ...(includeCoverage
              ? {
                  channelListings: {
                    select: {
                      channel: true,
                      marketplace: true,
                      listingStatus: true,
                      lastSyncStatus: true,
                      isPublished: true,
                    },
                  },
                }
              : {}),
          },
        })

  // Stats reflect the FILTERED set — the same counts a grouped level reports for its scope.
  const statsPromise = countStatsTuple({ where, cacheWhere, useCache })

  const [rawProducts, total, statsRows] = await Promise.all([
    rawProductsPromise,
    Promise.resolve(etagCount),
    statsPromise,
  ])

  // U.29 / PN.1 — when a pre-ordered sort is active, re-order to match the
  // prefetched id sequence (IN-list doesn't preserve order).
  let sortedRawProducts = rawProducts
  if (preorderedIds) {
    const byId = new Map(rawProducts.map((p: any) => [p.id, p]))
    sortedRawProducts = preorderedIds
      .map((id) => byId.get(id))
      .filter((p): p is (typeof rawProducts)[number] => !!p)
  }

  // Optional tag rollup — single grouped query, fan out client-side
  let tagsByProduct: Map<string, Array<{ id: string; name: string; color: string | null }>> = new Map()
  if (includeTags) {
    const productIds = sortedRawProducts.map((p) => p.id)
    const rows = await prisma.productTag.findMany({
      where: { productId: { in: productIds } },
      select: {
        productId: true,
        tag: { select: { id: true, name: true, color: true, icon: true } },
      },
    })
    for (const r of rows) {
      const arr = tagsByProduct.get(r.productId) ?? []
      arr.push(r.tag)
      tagsByProduct.set(r.productId, arr)
    }
  }

  // Fulfillment derivation (offers > stock locations > Product.fulfillmentMethod).
  // Two cheap side queries on the page's product ids; overlay live signal
  // on top of whatever raw value the cache or direct path returned.
  const pageProductIds = sortedRawProducts.map((p) => p.id)
  const offersByProduct = new Map<string, Set<'FBA' | 'FBM'>>()
  const stockByProduct = new Map<string, { fba: number; non: number }>()
  const salesByProduct = new Map<string, { units: number; revenueCents: number }>()
  let salesUnattributed: Array<{ channel: string; orders: number; units: number; revenueCents: number }> = []
  if (pageProductIds.length > 0) {
    // Stock lives on the child (variation) products — a parent owns none
    // directly — so a parent's Available total is the sum across its
    // children. Pull the children of any parents on this page so their
    // stock can be rolled up onto the parent row.
    const childRows = await prisma.product.findMany({
      where: { parentId: { in: pageProductIds } },
      select: { id: true, parentId: true },
    })
    const childToParent = new Map<string, string>(
      childRows.map((c) => [c.id, c.parentId as string]),
    )
    const stockIds = [...pageProductIds, ...childRows.map((c) => c.id)]

    const [offerRows, stockRows] = await Promise.all([
      prisma.offer.findMany({
        where: {
          isActive: true,
          channelListing: { productId: { in: pageProductIds } },
        },
        select: {
          fulfillmentMethod: true,
          channelListing: { select: { productId: true } },
        },
      }),
      prisma.stockLevel.findMany({
        where: { productId: { in: stockIds } },
        select: {
          productId: true,
          quantity: true,
          location: { select: { type: true } },
        },
      }),
    ])
    for (const o of offerRows) {
      const pid = o.channelListing.productId
      const s = offersByProduct.get(pid) ?? new Set<'FBA' | 'FBM'>()
      s.add(o.fulfillmentMethod as 'FBA' | 'FBM')
      offersByProduct.set(pid, s)
    }
    for (const s of stockRows) {
      // A child's stock rolls up to its parent's row; a standalone /
      // top-level product's own stock stays on itself.
      const ownerId = childToParent.get(s.productId) ?? s.productId
      const cur = stockByProduct.get(ownerId) ?? { fba: 0, non: 0 }
      if (s.location.type === 'AMAZON_FBA') cur.fba += s.quantity
      else cur.non += s.quantity
      stockByProduct.set(ownerId, cur)
    }

    // Sales roll up exactly like stock, and for the same reason: measured on this
    // database, ALL 859 ProductProfitDaily rows attach to a child and NONE to a parent, so
    // a Sales column read straight off the product row would render 0.00 for every parent
    // in the grid. `childToParent` is the same map the stock fold uses.
    //
    // 🔴 SOURCE IS ORDERS, NOT ProductProfitDaily — this is the whole point.
    // `ProductProfitDaily.marketplace` holds IT/DE/FR/ES: those are Amazon COUNTRIES, not
    // channels. The table is Amazon-only, so summing it gives a figure labelled "Sales"
    // that silently means "Amazon sales", excludes the eBay orders that already exist, and
    // contributes nothing for any channel connected later. `Order.channel` is an enum of
    // AMAZON | EBAY | SHOPIFY | WOOCOMMERCE | ETSY | MANUAL, so orders are channel-agnostic
    // by construction and a new channel counts the day it lands.
    //
    // Three filters, each load-bearing:
    //   • status <> CANCELLED — 531 of 4,426 orders are cancelled; including them added
    //     €124.84 of revenue that never happened to the 90-day window.
    //   • productId IS NOT NULL — an unattributable line cannot be charged to a product.
    //     This is not cosmetic: all four eBay orders are currently orphaned this way, so
    //     eBay revenue is real, is NOT counted here, and `salesUnattributed` reports it
    //     rather than letting it vanish.
    //   • the window, shared with the label the client renders.
    //
    // Raw SQL because the figure is SUM(quantity × price) and Prisma's groupBy cannot
    // aggregate an expression. Currency is EUR on all 4,426 orders today; if a second one
    // ever appears this sum is wrong and `currencies` below is what will say so.
    if (includeSales) {
      const since = new Date()
      since.setUTCDate(since.getUTCDate() - salesDays)
      const salesRows = await prisma.$queryRaw<
        Array<{ productId: string; units: bigint | number; revenueCents: bigint | number }>
      >`
        SELECT oi."productId" AS "productId",
               SUM(oi.quantity)::bigint AS units,
               ROUND(SUM(oi.quantity * oi.price) * 100)::bigint AS "revenueCents"
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        WHERE oi."productId" IN (${Prisma.join(stockIds)})
          AND o."createdAt" >= ${since}
          AND o.status <> 'CANCELLED'
        GROUP BY oi."productId"
      `
      for (const r of salesRows) {
        const ownerId = childToParent.get(r.productId) ?? r.productId
        const cur = salesByProduct.get(ownerId) ?? { units: 0, revenueCents: 0 }
        cur.units += Number(r.units ?? 0)
        cur.revenueCents += Number(r.revenueCents ?? 0)
        salesByProduct.set(ownerId, cur)
      }

      // Revenue the column CANNOT show, reported rather than dropped. An order line with no
      // productId is a real sale that no product row can carry — measured over 90 days:
      // €840.00 on Amazon and €109.95 on eBay, ~1.9% of the window. Without this the column
      // simply under-reports and looks precise while doing it, which is worse than a gap you
      // can see. Per-channel because the reason differs by channel and the fix does too.
      const orphanRows = await prisma.$queryRaw<
        Array<{ channel: string; orders: bigint | number; units: bigint | number; revenueCents: bigint | number }>
      >`
        SELECT o.channel::text AS channel,
               COUNT(DISTINCT o.id)::bigint AS orders,
               SUM(oi.quantity)::bigint AS units,
               ROUND(SUM(oi.quantity * oi.price) * 100)::bigint AS "revenueCents"
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        WHERE oi."productId" IS NULL
          AND o."createdAt" >= ${since}
          AND o.status <> 'CANCELLED'
        GROUP BY 1
      `
      salesUnattributed = orphanRows.map((r) => ({
        channel: r.channel,
        orders: Number(r.orders ?? 0),
        units: Number(r.units ?? 0),
        revenueCents: Number(r.revenueCents ?? 0),
      }))
    }
  }

  // P-RT.5 — OutboundSyncQueue rollup per product. Gated on
  // includeCoverage to keep the lightweight default fetch cheap;
  // the grid's "sync-status" column is opt-in. One findMany
  // bounded by the page's productIds; in-memory aggregation
  // picks the most-urgent state per product. State precedence:
  //   dead > failed (retrying) > pending > succeeded.
  // syncedAt is the most-recent successful sync across channels —
  // drives the "Synced Nm ago" copy when no in-flight work.
  const syncQueueByProduct = new Map<
    string,
    {
      pending: number
      failed: number
      dead: number
      syncedAt: string | null
      mostUrgentChannel: string | null
      mostUrgentStatus: 'PENDING' | 'FAILED' | 'DEAD' | 'SYNCED' | null
    }
  >()
  if (includeCoverage && pageProductIds.length > 0) {
    const queueRows = await prisma.outboundSyncQueue.findMany({
      where: { productId: { in: pageProductIds } },
      select: {
        productId: true,
        targetChannel: true,
        syncStatus: true,
        syncedAt: true,
        isDead: true,
        updatedAt: true,
      },
      // Newest-first so the per-product fold sees recent rows
      // before older retries when picking mostUrgentChannel.
      orderBy: { updatedAt: 'desc' },
    })
    for (const r of queueRows) {
      if (!r.productId) continue
      const cur = syncQueueByProduct.get(r.productId) ?? {
        pending: 0, failed: 0, dead: 0,
        syncedAt: null,
        mostUrgentChannel: null,
        mostUrgentStatus: null,
      }
      const isPending = r.syncStatus === 'PENDING'
      const isFailed = r.syncStatus === 'FAILED' && !r.isDead
      // OutboundSyncStatus enum value is SUCCESS (not SUCCEEDED).
      const isSucceeded = r.syncStatus === 'SUCCESS'
      if (r.isDead) cur.dead++
      else if (isFailed) cur.failed++
      else if (isPending) cur.pending++
      if (isSucceeded && r.syncedAt) {
        const candidate = r.syncedAt.toISOString()
        if (!cur.syncedAt || candidate > cur.syncedAt) cur.syncedAt = candidate
      }
      // Pick mostUrgentChannel/Status by precedence. Once we've
      // picked DEAD we don't downgrade; on FAILED we don't downgrade
      // to PENDING; PENDING only loses to FAILED/DEAD.
      const rank = (s: typeof cur.mostUrgentStatus): number =>
        s === 'DEAD' ? 3 : s === 'FAILED' ? 2 : s === 'PENDING' ? 1 : s === 'SYNCED' ? 0 : -1
      const candidateStatus: typeof cur.mostUrgentStatus =
        r.isDead ? 'DEAD' :
        isFailed ? 'FAILED' :
        isPending ? 'PENDING' :
        isSucceeded ? 'SYNCED' : null
      if (candidateStatus && rank(candidateStatus) > rank(cur.mostUrgentStatus)) {
        cur.mostUrgentStatus = candidateStatus
        cur.mostUrgentChannel = r.targetChannel
      }
      syncQueueByProduct.set(r.productId, cur)
    }
  }

  // ES.3 — transform either a ProductReadCache row or a full Prisma
  // Product row into the canonical ProductRow shape.
  const products = sortedRawProducts.map((p: any) => {
    let coverage: Record<string, { live: number; draft: number; error: number; total: number }> | null = null

    const stockBuckets = stockByProduct.get(p.id) ?? { fba: 0, non: 0 }
    const derivedFulfillment = deriveFulfillmentMethod({
      offerMethods: offersByProduct.get(p.id),
      stock: stockBuckets,
      fallback: (p.fulfillmentMethod ?? null) as 'FBA' | 'FBM' | null,
    })

    if (useCache) {
      // Cache path: counts + family + workflowStage are pre-built columns/JSON.
      if (includeCoverage && p.coverageJson) {
        coverage = p.coverageJson as typeof coverage
      }
      return {
        id: p.id,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        basePrice: p.basePrice != null ? Number(p.basePrice) : null,
        totalStock: p.totalStock,
        lowStockThreshold: p.lowStockThreshold,
        status: p.status,
        syncChannels: p.syncChannels,
        updatedAt: p.updatedAt,
        createdAt: p.createdAt,
        isParent: p.isParent,
        parentId: p.parentId,
        productType: p.productType,
        fulfillmentMethod: derivedFulfillment,
        fbaStock: stockBuckets.fba,
        fbmStock: stockBuckets.non,
        family: (p.familyJson as any) ?? null,
        workflowStage: (p.workflowStageJson as any) ?? null,
        version: p.version,
        imageUrl: p.imageUrl ?? null,
        amazonAsin: null,
        photoCount: p.photoCount,
        channelCount: p.channelCount,
        variantCount: p.variantCount,
        childCount: p.childCount,
        driftCount: (p as any).driftCount ?? 0,
        // Same field on BOTH response paths. This branch returns its own object literal, so
        // adding `sales` only to the live-query branch below would leave it `undefined`
        // whenever the read cache serves the page — the column would render empty on a
        // cache hit and fill on a miss, which is the hardest kind of bug to reproduce.
        // `salesByProduct` is folded before the branch, so it is in scope for both.
        sales: includeSales
          ? { ...(salesByProduct.get(p.id) ?? { units: 0, revenueCents: 0 }), days: salesDays }
          : null,
        coverage,
        // P-RT.5 — outbound queue rollup. Null when includeCoverage
        // is false; populated map miss = empty state (no queue rows
        // for this product).
        syncQueue: includeCoverage
          ? (syncQueueByProduct.get(p.id) ?? {
              pending: 0, failed: 0, dead: 0,
              syncedAt: null, mostUrgentChannel: null, mostUrgentStatus: null,
            })
          : null,
        tags: includeTags ? (tagsByProduct.get(p.id) ?? []) : undefined,
      }
    }

    // Direct Prisma path (unchanged original transform).
    const photoCount = p._count?.images ?? 0
    if (includeCoverage && Array.isArray(p.channelListings)) {
      coverage = {}
      for (const cl of p.channelListings) {
        const c = (coverage[cl.channel] ??= { live: 0, draft: 0, error: 0, total: 0 })
        c.total++
        if (cl.listingStatus === 'ACTIVE' && cl.isPublished) c.live++
        else if (cl.listingStatus === 'DRAFT') c.draft++
        else if (cl.listingStatus === 'ERROR' || cl.lastSyncStatus === 'FAILED') c.error++
      }
    }
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      basePrice: Number(p.basePrice),
      totalStock: p.totalStock,
      lowStockThreshold: p.lowStockThreshold,
      status: p.status,
      syncChannels: p.syncChannels,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      isParent: p.isParent,
      parentId: p.parentId,
      productType: p.productType,
      fulfillmentMethod: derivedFulfillment,
      fbaStock: stockBuckets.fba,
      fbmStock: stockBuckets.non,
      family: p.family ?? null,
      workflowStage: p.workflowStage ?? null,
      version: p.version,
      imageUrl: pickFaceImage(p.images ?? []),
      amazonAsin: p.amazonAsin ?? null,
      photoCount,
      channelCount: p._count?.channelListings ?? 0,
      variantCount: p._count?.variations ?? 0,
      childCount: p._count?.children ?? 0,
      // `null` when not requested, so a consumer can tell "not asked" from "asked, none" —
      // a zero would read as a measured no-sales. `days` travels with the figures so the
      // column can label its own window instead of assuming one.
      sales: includeSales
        ? { ...(salesByProduct.get(p.id) ?? { units: 0, revenueCents: 0 }), days: salesDays }
        : null,
      coverage,
      // P-RT.5 — see cache path above for shape rationale.
      syncQueue: includeCoverage
        ? (syncQueueByProduct.get(p.id) ?? {
            pending: 0, failed: 0, dead: 0,
            syncedAt: null, mostUrgentChannel: null, mostUrgentStatus: null,
          })
        : null,
      tags: includeTags ? (tagsByProduct.get(p.id) ?? []) : undefined,
    }
  })

  const body = {
    products,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    // Per-channel revenue in the window that no product row can carry. `null` when sales
    // were not requested; `[]` when every line attributed cleanly.
    salesUnattributed: includeSales ? salesUnattributed : null,
    stats: {
      total: statsRows[0],
      active: statsRows[1],
      draft: statsRows[2],
      inStock: statsRows[3],
      outOfStock: statsRows[4],
    },
  }
  return { status: 200 as const, etag, body }
}
