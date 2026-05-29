/**
 * Product search service — the faceted read path for the /products grid.
 *
 * Two interchangeable backends behind one contract:
 *   • PRIMARY  (SEARCH_ENGINE_ENABLED=1 + Typesense healthy): Typesense
 *     does the filtering / sorting / faceting (the expensive part) and
 *     returns ordered ids + total + facet counts. We then hydrate the
 *     DISPLAY payload for that page from ProductReadCache — so the item
 *     shape is byte-identical to the cache path and we never store rich
 *     JSON (family / workflow / coverage / breadcrumb) twice.
 *   • FALLBACK (search off or unhealthy): a plain ProductReadCache
 *     findMany with an equivalent Prisma where/orderBy. Always correct,
 *     so flipping SEARCH_ENGINE_ENABLED is a safe, instant rollback.
 *
 * Stats (total / active / draft / inStock / outStock) are computed from
 * ProductReadCache counts in BOTH paths so the status tabs stay
 * consistent regardless of which backend served the page.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import {
  isSearchConfigured,
  searchHealthy,
  searchProducts,
} from '../lib/typesense.js'

export interface ProductSearchFilters {
  page: number
  limit: number
  search?: string
  status: string[]
  channels: string[] // channelKeys, e.g. AMAZON_IT
  productTypes: string[]
  brands: string[]
  families: string[]
  workflowStages: string[]
  fulfillment: string[] // FBA | FBM
  categories: string[] // category id; matches whole subtree via rollup
  hasPhotos?: boolean
  hasDescription?: boolean
  hasBrand?: boolean
  hasGtin?: boolean
  driftOnly: boolean
  stockLevel?: 'in' | 'low' | 'out'
  parentId?: string // children of this parent
  includeChildren: boolean // when false (default), hide child variants
  sort: string // e.g. 'updated-desc'
}

const MAX_LIMIT = 200

function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string' && v.length > 0) return v.split(',').filter(Boolean)
  return []
}

function bool(v: unknown): boolean | undefined {
  if (v === '1' || v === 'true' || v === true) return true
  if (v === '0' || v === 'false' || v === false) return false
  return undefined
}

/** Parse the raw Fastify querystring into normalized filters. */
export function parseFilters(q: Record<string, unknown>): ProductSearchFilters {
  const page = Math.max(parseInt(String(q.page ?? '1'), 10) || 1, 1)
  const limit = Math.max(
    Math.min(parseInt(String(q.limit ?? '50'), 10) || 50, MAX_LIMIT),
    1,
  )
  const stockRaw = typeof q.stockLevel === 'string' ? q.stockLevel : undefined
  return {
    page,
    limit,
    search: typeof q.search === 'string' && q.search.trim() ? q.search.trim() : undefined,
    status: arr(q.status),
    channels: arr(q.channels),
    productTypes: arr(q.productTypes),
    brands: arr(q.brands),
    families: arr(q.families),
    workflowStages: arr(q.workflowStages),
    fulfillment: arr(q.fulfillment),
    categories: arr(q.categories),
    hasPhotos: bool(q.hasPhotos),
    hasDescription: bool(q.hasDescription),
    hasBrand: bool(q.hasBrand),
    hasGtin: bool(q.hasGtin),
    driftOnly: bool(q.driftOnly) === true,
    stockLevel:
      stockRaw === 'in' || stockRaw === 'low' || stockRaw === 'out'
        ? stockRaw
        : undefined,
    parentId: typeof q.parentId === 'string' && q.parentId ? q.parentId : undefined,
    includeChildren: bool(q.includeChildren) === true,
    sort: typeof q.sort === 'string' && q.sort ? q.sort : 'updated-desc',
  }
}

// ── Prisma where (fallback + stats) ────────────────────────────────────────
function buildCacheWhere(
  f: ProductSearchFilters,
  opts: { includeStatus: boolean },
): Prisma.ProductReadCacheWhereInput {
  const where: Prisma.ProductReadCacheWhereInput = { deletedAt: null }
  if (opts.includeStatus && f.status.length) where.status = { in: f.status }
  if (f.brands.length) where.brand = { in: f.brands }
  if (f.productTypes.length) where.productType = { in: f.productTypes }
  if (f.fulfillment.length) where.fulfillmentMethod = { in: f.fulfillment }
  if (f.families.length) where.familyId = { in: f.families }
  if (f.workflowStages.length) where.workflowStageId = { in: f.workflowStages }
  if (f.channels.length) where.channelKeys = { hasSome: f.channels }
  if (f.categories.length) where.categoryIds = { hasSome: f.categories }
  if (f.hasPhotos !== undefined) where.hasPhotos = f.hasPhotos
  if (f.hasDescription !== undefined) where.hasDescription = f.hasDescription
  if (f.hasBrand !== undefined) where.hasBrand = f.hasBrand
  if (f.hasGtin !== undefined) where.hasGtin = f.hasGtin
  if (f.driftOnly) where.driftCount = { gt: 0 }
  if (f.stockLevel === 'in') where.totalStock = { gt: 0 }
  else if (f.stockLevel === 'low') where.totalStock = { gt: 0, lte: 5 }
  else if (f.stockLevel === 'out') where.totalStock = 0
  if (f.search) {
    where.OR = [
      { name: { contains: f.search, mode: 'insensitive' } },
      { sku: { contains: f.search, mode: 'insensitive' } },
      { brand: { contains: f.search, mode: 'insensitive' } },
    ]
  }
  if (f.parentId) where.parentId = f.parentId
  else if (!f.includeChildren) where.parentId = null
  return where
}

function cacheOrderBy(sort: string): Prisma.ProductReadCacheOrderByWithRelationInput {
  switch (sort) {
    case 'name-asc': return { name: 'asc' }
    case 'name-desc': return { name: 'desc' }
    case 'sku-asc': return { sku: 'asc' }
    case 'sku-desc': return { sku: 'desc' }
    case 'price-asc': return { basePrice: 'asc' }
    case 'price-desc': return { basePrice: 'desc' }
    case 'stock-asc': return { totalStock: 'asc' }
    case 'stock-desc': return { totalStock: 'desc' }
    case 'created-asc': return { createdAt: 'asc' }
    case 'created-desc': return { createdAt: 'desc' }
    case 'updated-asc': return { updatedAt: 'asc' }
    case 'updated-desc':
    default: return { updatedAt: 'desc' }
  }
}

// ── Typesense params ────────────────────────────────────────────────────────
function tsFilterValues(field: string, values: string[]): string {
  // Backtick-quote each value so spaces / commas in brands etc. are safe.
  return `${field}:=[${values.map((v) => `\`${v}\``).join(',')}]`
}

function buildTypesenseParams(
  f: ProductSearchFilters,
): Record<string, string | number | boolean> {
  const filters: string[] = ['deletedAt:=0']
  if (f.status.length) filters.push(tsFilterValues('status', f.status))
  if (f.brands.length) filters.push(tsFilterValues('brand', f.brands))
  if (f.productTypes.length) filters.push(tsFilterValues('productType', f.productTypes))
  if (f.fulfillment.length) filters.push(tsFilterValues('fulfillmentMethod', f.fulfillment))
  if (f.families.length) filters.push(tsFilterValues('familyId', f.families))
  if (f.workflowStages.length) filters.push(tsFilterValues('workflowStageId', f.workflowStages))
  if (f.channels.length) filters.push(tsFilterValues('channelKeys', f.channels))
  if (f.categories.length) filters.push(tsFilterValues('categoryIds', f.categories))
  if (f.hasPhotos !== undefined) filters.push(`hasPhotos:=${f.hasPhotos}`)
  if (f.hasDescription !== undefined) filters.push(`hasDescription:=${f.hasDescription}`)
  if (f.hasBrand !== undefined) filters.push(`hasBrand:=${f.hasBrand}`)
  if (f.hasGtin !== undefined) filters.push(`hasGtin:=${f.hasGtin}`)
  if (f.driftOnly) filters.push('driftCount:>0')
  if (f.stockLevel === 'in') filters.push('totalStock:>0')
  else if (f.stockLevel === 'low') filters.push('totalStock:>0 && totalStock:<=5')
  else if (f.stockLevel === 'out') filters.push('totalStock:=0')
  if (f.parentId) filters.push(`parentId:=\`${f.parentId}\``)
  else if (!f.includeChildren) filters.push('isChild:=false')

  const sortMap: Record<string, string> = {
    'name-asc': 'name:asc', 'name-desc': 'name:desc',
    'sku-asc': 'sku:asc', 'sku-desc': 'sku:desc',
    'price-asc': 'basePrice:asc', 'price-desc': 'basePrice:desc',
    'stock-asc': 'totalStock:asc', 'stock-desc': 'totalStock:desc',
    'created-asc': 'createdAt:asc', 'created-desc': 'createdAt:desc',
    'updated-asc': 'updatedAt:asc', 'updated-desc': 'updatedAt:desc',
  }

  return {
    q: f.search ?? '*',
    query_by: 'name,name_it,sku,brand',
    filter_by: filters.join(' && '),
    facet_by:
      'brand,productType,status,fulfillmentMethod,familyId,workflowStageId,channelKeys,categoryIds,isParent',
    max_facet_values: 100,
    sort_by: sortMap[f.sort] ?? 'updatedAt:desc',
    page: f.page,
    per_page: f.limit,
    // We hydrate the display payload from Postgres, so only the id is
    // needed back from Typesense — keep the response lean.
    include_fields: 'id',
  }
}

// ── Item mapping (shared by both paths) ─────────────────────────────────────
type CacheRow = NonNullable<
  Awaited<ReturnType<typeof prisma.productReadCache.findUnique>>
>

function mapRow(r: CacheRow) {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    brand: r.brand,
    basePrice: r.basePrice != null ? Number(r.basePrice) : null,
    totalStock: r.totalStock,
    lowStockThreshold: r.lowStockThreshold,
    status: r.status,
    syncChannels: r.syncChannels,
    productType: r.productType,
    fulfillmentMethod: r.fulfillmentMethod,
    isParent: r.isParent,
    parentId: r.parentId,
    version: r.version,
    family: r.familyJson ?? null,
    workflowStage: r.workflowStageJson ?? null,
    imageUrl: r.imageUrl,
    photoCount: r.photoCount,
    channelCount: r.channelCount,
    variantCount: r.variantCount,
    childCount: r.childCount,
    hasDescription: r.hasDescription,
    hasBrand: r.hasBrand,
    hasGtin: r.hasGtin,
    hasPhotos: r.hasPhotos,
    channelKeys: r.channelKeys,
    driftCount: r.driftCount,
    coverage: r.coverageJson ?? null,
    primaryCategoryId: r.primaryCategoryId,
    categoryIds: r.categoryIds,
    categoryPath: r.categoryPathJson ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

async function computeStats(f: ProductSearchFilters) {
  // Stats exclude the status dimension so the status tabs always show
  // full counts within the other active filters.
  const base = buildCacheWhere(f, { includeStatus: false })
  const [total, active, draft, inStock, outStock] = await Promise.all([
    prisma.productReadCache.count({ where: base }),
    prisma.productReadCache.count({ where: { ...base, status: 'ACTIVE' } }),
    prisma.productReadCache.count({ where: { ...base, status: 'DRAFT' } }),
    prisma.productReadCache.count({ where: { ...base, totalStock: { gt: 0 } } }),
    prisma.productReadCache.count({ where: { ...base, totalStock: 0 } }),
  ])
  return { total, active, draft, inStock, outStock }
}

export type ProductSearchResult = {
  items: ReturnType<typeof mapRow>[]
  total: number
  page: number
  limit: number
  stats: { total: number; active: number; draft: number; inStock: number; outStock: number }
  facets: Record<string, Array<{ value: string; count: number }>>
  engine: 'typesense' | 'cache'
}

async function cachePath(f: ProductSearchFilters): Promise<ProductSearchResult> {
  const where = buildCacheWhere(f, { includeStatus: true })
  const [rows, total, stats] = await Promise.all([
    prisma.productReadCache.findMany({
      where,
      orderBy: cacheOrderBy(f.sort),
      take: f.limit,
      skip: (f.page - 1) * f.limit,
    }),
    prisma.productReadCache.count({ where }),
    computeStats(f),
  ])

  // Lightweight facets from single-table groupBys (arrays not groupable).
  const facetFields: Array<keyof Prisma.ProductReadCacheGroupByOutputType> = [
    'brand', 'productType', 'status', 'fulfillmentMethod', 'familyId', 'workflowStageId',
  ]
  const facets: ProductSearchResult['facets'] = {}
  await Promise.all(
    facetFields.map(async (field) => {
      const grouped = await prisma.productReadCache.groupBy({
        by: [field as any],
        where,
        _count: { _all: true },
      })
      facets[field as string] = grouped
        .filter((g: any) => g[field] != null)
        .map((g: any) => ({ value: String(g[field]), count: g._count._all }))
        .sort((a, b) => b.count - a.count)
    }),
  )

  return {
    items: rows.map(mapRow),
    total,
    page: f.page,
    limit: f.limit,
    stats,
    facets,
    engine: 'cache',
  }
}

async function typesensePath(f: ProductSearchFilters): Promise<ProductSearchResult> {
  const res = await searchProducts(buildTypesenseParams(f))
  const ids = res.hits.map((h) => h.document.id)

  // Hydrate the display payload for this page from the canonical read
  // model, then restore Typesense's ordering (IN-list loses order).
  const rows = ids.length
    ? await prisma.productReadCache.findMany({ where: { id: { in: ids } } })
    : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const items = ids
    .map((id) => byId.get(id))
    .filter((r): r is CacheRow => !!r)
    .map(mapRow)

  const facets: ProductSearchResult['facets'] = {}
  for (const fc of res.facet_counts ?? []) {
    facets[fc.field_name] = fc.counts.map((c) => ({ value: c.value, count: c.count }))
  }

  return {
    items,
    total: res.found,
    page: f.page,
    limit: f.limit,
    stats: await computeStats(f),
    facets,
    engine: 'typesense',
  }
}

/** Resolve the page using Typesense when available, else ProductReadCache. */
export async function searchProductsGrid(
  f: ProductSearchFilters,
): Promise<ProductSearchResult> {
  if (isSearchConfigured() && (await searchHealthy())) {
    try {
      return await typesensePath(f)
    } catch {
      // Any Typesense hiccup → degrade to the always-correct cache path.
      return cachePath(f)
    }
  }
  return cachePath(f)
}
