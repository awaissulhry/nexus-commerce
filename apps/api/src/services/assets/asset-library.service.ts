/**
 * MCP full control P3 — the image library reads, in one place: the unified library (DigitalAsset + ProductImage), the
 * tags and the folder tree. assets.routes.ts calls these, and so does Claude's `image-library` read.
 *
 * Moved from assets.routes.ts without a change in behaviour: the routes answer byte for byte as before
 * (asset-library.service.vitest.test.ts). Every read runs in the caller's business.
 *
 * MCP full control P7 — and the writes Claude's organize-image-library uses: an asset's label (and code, metadata), its
 * tag set, moving assets between folders. PATCH /api/assets/:id, PUT /api/assets/:id/tags and POST /api/assets/move call
 * these; asset-writes.vitest.test.ts holds their answers byte for byte. Deleting assets or folders stays in the route.
 */

import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'

/** The DigitalAsset types the library filters by and an upload may declare. */
export const VALID_ASSET_TYPES = new Set(['image', 'video', 'document', 'model3d'])

export interface AssetLibraryQuery {
  type?: string
  types?: string // comma-separated alt input
  sources?: string // 'digital_asset,product_image'
  usage?: string // 'in_use' | 'orphaned'
  missingAlt?: string // '1' / 'true' to filter
  dateRange?: string // 'today' | 'last_7d' | 'last_30d'
  tagIds?: string // comma-separated, narrows DigitalAssets to those with ALL named tags
  folderId?: string // 'unfiled' for null, '*' / unset for any, otherwise the folder id
  search?: string
  page?: string
  pageSize?: string
  // IE.7 — Cross-product scoping. When set, narrows to
  // DigitalAssets used by at least one Product matching the
  // given brand / productType. Lets the DAM picker surface
  // "assets already in use by other products in this brand /
  // category" first, encouraging cross-product reuse instead
  // of re-upload.
  relatedBrand?: string
  relatedProductType?: string
}

/**
 * GET /api/assets/library — the unified library: DigitalAsset rows and ProductImage rows merged into one feed, newest
 * first, filtered and paged. `options.liveProductsOnly` (never passed by the route) leaves out ProductImage rows of
 * deleted products, in the total and in the rows.
 */
export async function listAssetLibrary(q: AssetLibraryQuery, options: { liveProductsOnly?: boolean } = {}) {
  const page = Math.max(parseInt(q.page ?? '1', 10) || 1, 1)
  const pageSize = Math.min(
    Math.max(parseInt(q.pageSize ?? '60', 10) || 60, 1),
    200,
  )
  // Accept either ?type=image (legacy) or ?types=image,video. The
  // multi-value form keeps the URL short when the operator filters
  // to images-and-videos via the MC.1.3 sidebar.
  const requestedTypes = new Set<string>()
  if (q.type && VALID_ASSET_TYPES.has(q.type)) requestedTypes.add(q.type)
  if (q.types) {
    for (const v of q.types.split(',').map((s) => s.trim())) {
      if (VALID_ASSET_TYPES.has(v)) requestedTypes.add(v)
    }
  }
  const typeFilter = requestedTypes.size > 0 ? [...requestedTypes] : null

  const sourceFilter = q.sources
    ? new Set(
        q.sources
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s === 'digital_asset' || s === 'product_image'),
      )
    : null

  const usageFilter =
    q.usage === 'in_use' || q.usage === 'orphaned' ? q.usage : null
  const missingAlt = q.missingAlt === '1' || q.missingAlt === 'true'

  const tagIds = q.tagIds
    ? q.tagIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []

  // folderId: 'unfiled' filters to NULL (assets with no folder),
  // any other non-empty value narrows to that folder. Unset means
  // "every folder including unfiled".
  const folderFilter: 'unfiled' | string | null = q.folderId
    ? q.folderId === 'unfiled'
      ? 'unfiled'
      : q.folderId
    : null

  let dateFrom: Date | null = null
  if (q.dateRange) {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    if (q.dateRange === 'today')
      dateFrom = new Date(now - day)
    else if (q.dateRange === 'last_7d')
      dateFrom = new Date(now - 7 * day)
    else if (q.dateRange === 'last_30d')
      dateFrom = new Date(now - 30 * day)
  }

  const search = q.search?.trim() || null

  // Step 1 — figure out which sources are eligible.
  //   - `sources` filter narrows explicitly.
  //   - `type` filter implicitly excludes ProductImage when the
  //     operator picks anything other than 'image'.
  //   - `missingAlt` only matches ProductImage rows today (the
  //     DigitalAsset alt lives in metadata.alt, an unindexed JSON
  //     path; revisit when MC.2 gives DigitalAsset a dedicated
  //     altText column).
  const sourceAllowsDigitalAsset =
    !sourceFilter || sourceFilter.has('digital_asset')
  const sourceAllowsProductImage =
    !sourceFilter || sourceFilter.has('product_image')
  const typeAllowsProductImage =
    !typeFilter || typeFilter.includes('image')
  const includeDigitalAssets = sourceAllowsDigitalAsset && !missingAlt
  // Tag filter is DigitalAsset-only (ProductImage isn't taggable
  // until W4.7 migration cuts master gallery into the canonical
  // model). Active tag filter implicitly excludes ProductImage.
  const includeProductImages =
    sourceAllowsProductImage &&
    typeAllowsProductImage &&
    tagIds.length === 0 &&
    // Folder filter is DigitalAsset-only; any active folder
    // filter (including "unfiled") implicitly excludes ProductImage.
    folderFilter === null

  const daWhere: Record<string, unknown> = {}
  if (typeFilter) daWhere.type = { in: typeFilter }
  if (dateFrom) daWhere.createdAt = { gte: dateFrom }
  if (usageFilter === 'in_use') daWhere.usages = { some: {} }
  if (usageFilter === 'orphaned') daWhere.usages = { none: {} }
  if (tagIds.length > 0) {
    // AND-style: asset must carry every tag in the filter set.
    // Doing this with a single `tags: { every: ... }` filter is
    // tempting but `every` against a join model with no rows
    // matches everything, so spell it out as N AND'd `some`
    // clauses.
    daWhere.AND = tagIds.map((tagId) => ({
      tags: { some: { tagId } },
    }))
  }
  if (folderFilter === 'unfiled') daWhere.folderId = null
  else if (folderFilter) daWhere.folderId = folderFilter

  // IE.7 — Narrow to DigitalAssets used by at least one Product
  // matching the given brand / productType. Filters on the
  // AssetUsage join's product relation. Trim + case-insensitive
  // so the FE doesn't have to normalise.
  const relatedBrand = q.relatedBrand?.trim()
  const relatedProductType = q.relatedProductType?.trim()
  if (relatedBrand || relatedProductType) {
    const productFilter: Record<string, unknown> = {}
    if (relatedBrand) productFilter.brand = { equals: relatedBrand, mode: 'insensitive' }
    if (relatedProductType) productFilter.productType = { equals: relatedProductType, mode: 'insensitive' }
    const usageClause = {
      usages: { some: { scope: 'product', product: productFilter } },
    }
    // Compose with any existing AND clauses (e.g. tag filter).
    if (Array.isArray(daWhere.AND)) {
      ;(daWhere.AND as Array<Record<string, unknown>>).push(usageClause)
    } else {
      Object.assign(daWhere, usageClause)
    }
  }
  if (search) {
    // MC.1.4 — match the structured fields plus JSON-path captures
    // for caption and alt living under metadata. Prisma's
    // string_contains JSON filter does case-sensitive matching;
    // operator search is overwhelmingly lowercase so that's an
    // acceptable trade-off until we promote those JSON keys to
    // first-class columns. Tags are still array_contains so an
    // exact tag like "racing" matches; partial tag substring search
    // is a MC.2 follow-up that needs raw-SQL JSONB queries.
    daWhere.OR = [
      { label: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
      { originalFilename: { contains: search, mode: 'insensitive' } },
      { metadata: { path: ['caption'], string_contains: search } },
      { metadata: { path: ['alt'], string_contains: search } },
      { metadata: { path: ['tags'], array_contains: search } },
    ]
  }

  const piWhere: Record<string, unknown> = {}
  if (dateFrom) piWhere.createdAt = { gte: dateFrom }
  if (missingAlt) piWhere.OR = [{ alt: null }, { alt: '' }]
  if (usageFilter === 'orphaned') {
    // ProductImage rows are always attached to a product, so the
    // orphaned filter rules them out entirely.
    piWhere.id = '__never__'
  }
  if (search) {
    const searchOr = [
      { alt: { contains: search, mode: 'insensitive' } },
      { publicId: { contains: search, mode: 'insensitive' } },
      { product: { name: { contains: search, mode: 'insensitive' } } },
      { product: { sku: { contains: search, mode: 'insensitive' } } },
    ]
    if (piWhere.OR) {
      // missingAlt already set OR; combine via AND so both apply.
      piWhere.AND = [{ OR: piWhere.OR }, { OR: searchOr }]
      delete piWhere.OR
    } else {
      piWhere.OR = searchOr
    }
  }

  // MCP full control P3 — Claude's image-library read never shows a deleted product's photos. The library page does
  // not ask for this, so its query (and its answer) is exactly what it was.
  if (options.liveProductsOnly) piWhere.product = { deletedAt: null }

  const [daTotal, piTotal] = await Promise.all([
    includeDigitalAssets
      ? prisma.digitalAsset.count({ where: daWhere })
      : Promise.resolve(0),
    includeProductImages
      ? prisma.productImage.count({ where: piWhere })
      : Promise.resolve(0),
  ])
  const total = daTotal + piTotal

  // Step 2 — fetch enough rows from each table to satisfy the
  // requested page after merge. Worst case: all rows in one source
  // come before the other in createdAt order, so we fetch
  // (page * pageSize) rows from each. Capped at 1000 to keep the
  // round trip bounded — MC.2 keyset pagination removes this cap.
  const fetchLimit = Math.min(page * pageSize, 1000)

  const [daRows, piRows] = await Promise.all([
    includeDigitalAssets
      ? prisma.digitalAsset.findMany({
          where: daWhere,
          orderBy: { createdAt: 'desc' },
          take: fetchLimit,
          include: { _count: { select: { usages: true } } },
        })
      : Promise.resolve([] as never[]),
    includeProductImages
      ? prisma.productImage.findMany({
          where: piWhere,
          orderBy: { createdAt: 'desc' },
          take: fetchLimit,
          include: {
            product: { select: { id: true, sku: true, name: true } },
          },
        })
      : Promise.resolve([] as never[]),
  ])

  type LibraryItem = {
    id: string
    source: 'digital_asset' | 'product_image'
    url: string
    label: string
    type: string
    mimeType: string | null
    sizeBytes: number | null
    width: number | null
    height: number | null
    createdAt: string
    usageCount: number
    productId: string | null
    productSku: string | null
    productName: string | null
    role: string | null
    hasQualityWarnings: boolean
    /// MC.7.2 — surfaced for video tiles to render the duration
    /// badge without a detail-fetch roundtrip.
    durationSeconds: number | null
  }

  const merged: LibraryItem[] = []

  for (const a of daRows) {
    const meta = (a.metadata as Record<string, unknown> | null) ?? {}
    merged.push({
      id: `da_${a.id}`,
      source: 'digital_asset',
      url: a.url,
      label: a.label || a.originalFilename || 'Untitled',
      type: a.type,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      width:
        typeof meta.width === 'number' ? (meta.width as number) : null,
      height:
        typeof meta.height === 'number' ? (meta.height as number) : null,
      createdAt: a.createdAt.toISOString(),
      usageCount: a._count.usages,
      productId: null,
      productSku: null,
      productName: null,
      role: null,
      hasQualityWarnings:
        Array.isArray(meta.qualityWarnings) &&
        meta.qualityWarnings.length > 0,
      durationSeconds:
        typeof meta.durationSeconds === 'number'
          ? (meta.durationSeconds as number)
          : null,
    })
  }

  for (const p of piRows as Array<
    (typeof piRows)[number] & { product: { id: string; sku: string; name: string } | null }
  >) {
    merged.push({
      id: `pi_${p.id}`,
      source: 'product_image',
      url: p.url,
      label: p.alt || p.publicId || `${p.product?.sku ?? ''} ${p.type}`.trim(),
      type: 'image',
      mimeType: null,
      sizeBytes: null,
      width: null,
      height: null,
      createdAt: p.createdAt.toISOString(),
      // Each ProductImage row is intrinsically attached to one
      // product, so usageCount is 1 by definition. Setting 0 would
      // be misleading on the "Orphaned" KPI tile.
      usageCount: 1,
      productId: p.product?.id ?? null,
      productSku: p.product?.sku ?? null,
      productName: p.product?.name ?? null,
      role: p.type,
      // ProductImage rows pre-date MC.3.4 — they don't carry the
      // upload-time quality check. Always false until W4.7 cuts
      // them into DigitalAsset.
      hasQualityWarnings: false,
      durationSeconds: null,
    })
  }

  // Step 3 — sort merged feed by createdAt desc, paginate.
  merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const start = (page - 1) * pageSize
  const items = merged.slice(start, start + pageSize)
  const hasMore = start + items.length < total

  return {
    items,
    page,
    pageSize,
    total,
    hasMore,
  }
}

/** GET /api/asset-tags — every tag, by name, with how many assets, products and orders carry it. */
export async function listAssetTags() {
  const tags = await prisma.tag.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: { assets: true, products: true, orders: true },
      },
    },
  })
  return { tags }
}

/** GET /api/asset-folders — the whole folder tree as a flat list (parentId pointers), with asset and child counts. */
export async function listAssetFolders() {
  const folders = await prisma.assetFolder.findMany({
    orderBy: [{ parentId: 'asc' }, { order: 'asc' }, { name: 'asc' }],
    include: {
      _count: { select: { assets: true, children: true } },
    },
  })
  return { folders }
}

// ── Writes (MCP full control P7) ─────────────────────────────────────────────────────────────────────

/** An asset code, when it has one: lowercase snake_case. */
export const ASSET_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** What PATCH /api/assets/:id may change. The stored file (storage, url, mime type, size, type) never changes. */
export interface AssetFieldChange {
  label?: string
  code?: string | null
  metadata?: unknown
}

export type AssetFieldResult =
  | { ok: true; asset: Awaited<ReturnType<typeof prisma.digitalAsset.update>> }
  | { ok: false; status: 400 | 404 | 409; error: string }

/**
 * Change an asset's label, code or metadata. storageProvider/storageId/url/mimeType/sizeBytes/type are immutable on
 * purpose — to "swap" the underlying file the operator re-uploads, creates a new asset and re-attaches usages, which
 * keeps the audit story clean.
 */
export async function updateAssetFields(id: string, body: AssetFieldChange): Promise<AssetFieldResult> {
  const data: Record<string, unknown> = {}
  if (body.label !== undefined) {
    if (!body.label.trim()) return { ok: false, status: 400, error: 'label cannot be empty' }
    data.label = body.label.trim()
  }
  if (body.code !== undefined) {
    if (body.code && !ASSET_CODE_PATTERN.test(body.code)) {
      return { ok: false, status: 400, error: 'code (when provided) must be lowercase snake_case' }
    }
    data.code = body.code || null
  }
  if (body.metadata !== undefined) data.metadata = (body.metadata as never) ?? null
  if (Object.keys(data).length === 0) return { ok: false, status: 400, error: 'no mutable fields supplied' }
  try {
    const asset = await prisma.digitalAsset.update({ where: { id }, data })
    return { ok: true, asset }
  } catch (err: any) {
    if (err?.code === 'P2025') return { ok: false, status: 404, error: 'asset not found' }
    if (err?.code === 'P2002') return { ok: false, status: 409, error: `asset code "${body.code}" already exists` }
    throw err
  }
}

/**
 * Replace the tag set on a DigitalAsset: by ids, or by names — a name that is not a tag yet becomes one (the picker's
 * "type a new tag" case). Returns the asset's tags by name, or null when the asset is not there.
 */
export async function replaceAssetTags(assetId: string, body: { tagIds?: string[]; tagNames?: string[] }) {
  const asset = await prisma.digitalAsset.findUnique({
    where: { id: assetId },
    select: { id: true },
  })
  if (!asset) return null

  const idSet = new Set(body.tagIds ?? [])

  // Resolve names → ids, creating any that don't exist. createMany
  // with skipDuplicates would be cleaner but doesn't return rows;
  // upsert one-by-one is fine here because the picker shouldn't
  // routinely create more than a handful.
  if (body.tagNames?.length) {
    for (const rawName of body.tagNames) {
      const name = rawName.trim()
      if (!name) continue
      const existing = await prisma.tag.findUnique({ where: { workspace_name: workspaceKey({ name: name }) } })
      if (existing) {
        idSet.add(existing.id)
      } else {
        const created = await prisma.tag.create({ data: { name } })
        idSet.add(created.id)
      }
    }
  }

  const tagIds = [...idSet]

  // Replace strategy — drop existing rows then create the new set.
  // Wrapped in a transaction so partial failures roll back; the
  // operator sees either the old set or the new, never a mix.
  await prisma.$transaction([
    prisma.assetTag.deleteMany({ where: { assetId } }),
    ...(tagIds.length
      ? [
          prisma.assetTag.createMany({
            data: tagIds.map((tagId) => ({ assetId, tagId })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ])

  return prisma.tag.findMany({
    where: { id: { in: tagIds } },
    orderBy: { name: 'asc' },
  })
}

/**
 * Move a set of assets to a folder, or to "unfiled" (folderId null): the bulk Move action and the detail drawer's
 * single move. An id that is not an asset of this business is simply not moved.
 */
export async function moveAssets(body: { assetIds?: string[]; folderId?: string | null }): Promise<
  { ok: true; moved: number; folderId: string | null } | { ok: false; error: string }
> {
  if (!Array.isArray(body.assetIds) || body.assetIds.length === 0) return { ok: false, error: 'assetIds array is required (1+ ids)' }
  if (body.folderId) {
    const folder = await prisma.assetFolder.findUnique({
      where: { id: body.folderId },
      select: { id: true },
    })
    if (!folder) return { ok: false, error: 'folderId does not exist' }
  }
  const updated = await prisma.digitalAsset.updateMany({
    where: { id: { in: body.assetIds } },
    data: { folderId: body.folderId ?? null },
  })
  return { ok: true, moved: updated.count, folderId: body.folderId ?? null }
}
