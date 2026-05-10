/**
 * W4.5 — DAM CRUD API.
 *
 * Asset metadata + usage join layer. Cloudinary upload integration
 * lives in the existing products-images.routes.ts; W4.5b will wire
 * that flow to ALSO create a DigitalAsset row (the existing
 * ProductImage path keeps working until W4.7 cuts over). Until then,
 * this API accepts pre-uploaded assets — caller provides storageId
 * + url after handling the upload to Cloudinary itself.
 *
 * Endpoints (all under /api):
 *
 *   DigitalAsset:
 *     GET    /assets                       list (?type, ?search,
 *                                            ?limit, ?cursor)
 *     GET    /assets/:id                   detail with usages
 *     POST   /assets                       create from { storage*,
 *                                            label, type, mimeType,
 *                                            sizeBytes, code?,
 *                                            metadata? }
 *     PATCH  /assets/:id                   update label / code /
 *                                            metadata. Storage
 *                                            fields immutable —
 *                                            re-upload + re-attach
 *                                            to "swap" a file.
 *     DELETE /assets/:id                   cascades AssetUsage rows
 *
 *   AssetUsage (per-product attach):
 *     POST   /products/:id/asset-usages    { assetId, role,
 *                                            sortOrder? }
 *     PATCH  /asset-usages/:id             update role / sortOrder
 *     DELETE /asset-usages/:id             detach (asset record
 *                                            survives + can be
 *                                            re-attached elsewhere)
 *
 * Validation:
 *   - asset code (optional): lowercase snake_case if provided
 *   - asset type: 'image' | 'video' | 'document' | 'model3d'
 *   - usage scope: 'product' for now (fixed)
 *   - usage role: any non-empty string ('main', 'alt', 'lifestyle',
 *     'hero', 'detail', 'packaging' — not enforced as enum so the
 *     channel-listing flow can introduce its own role names later)
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../services/cloudinary.service.js'

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const VALID_ASSET_TYPES = new Set(['image', 'video', 'document', 'model3d'])

// MC.3.1 — accept-list for direct upload. Image-first; video lands in
// MC.7 once we wire the transcoding pipeline. The mime-type guard is a
// defence-in-depth check after we already filter by extension on the
// client; servers should never trust the client.
const UPLOAD_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
])

// 25 MB cap for direct uploads. ProductImage hero photos at 4000×4000
// fit easily under this; anything larger probably belongs in the bulk
// ZIP flow (MC.3.2) or the dedicated video pipeline. Configurable via
// env if a workspace needs more.
const MAX_UPLOAD_BYTES = parseInt(
  process.env.MC_MAX_UPLOAD_BYTES ?? `${25 * 1024 * 1024}`,
  10,
)

const assetsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── DigitalAsset ────────────────────────────────────────────

  // MC.1.1 — DAM hub KPI overview. Single roundtrip for the
  // /marketing/content header strip: total counts, type breakdown,
  // storage usage, in-use vs orphaned, plus a parallel count of
  // ProductImage rows so the operator sees the legacy + canonical
  // gallery state in one number until the W4.7 migration cuts over.
  // Returns shape consumed by ContentHubClient.
  fastify.get('/assets/overview', async () => {
    const [
      totalAssets,
      byTypeRaw,
      sizeAgg,
      inUseDistinct,
      productImageCount,
      videoCount,
      missingAltImages,
    ] = await Promise.all([
      prisma.digitalAsset.count(),
      prisma.digitalAsset.groupBy({
        by: ['type'],
        _count: { _all: true },
      }),
      prisma.digitalAsset.aggregate({
        _sum: { sizeBytes: true },
      }),
      prisma.assetUsage.findMany({
        select: { assetId: true },
        distinct: ['assetId'],
      }),
      prisma.productImage.count(),
      prisma.digitalAsset.count({ where: { type: 'video' } }),
      prisma.productImage.count({
        where: { OR: [{ alt: null }, { alt: '' }] },
      }),
    ])

    const byType: Record<string, number> = {}
    for (const row of byTypeRaw) byType[row.type] = row._count._all

    const inUseCount = inUseDistinct.length
    const orphanedCount = Math.max(totalAssets - inUseCount, 0)

    return {
      totalAssets,
      productImageCount,
      videoCount,
      byType,
      storageBytes: sizeAgg._sum.sizeBytes ?? 0,
      inUseCount,
      orphanedCount,
      needsAttention: {
        missingAltImages,
      },
    }
  })

  // MC.1.2 — unified library feed.
  //
  // Merges DigitalAsset (W4.5 canonical) with ProductImage (legacy
  // master gallery) into a single chronological feed. Until the W4.7
  // migration backfills ProductImage rows into DigitalAsset+
  // AssetUsage, the operator must see both sources or the library
  // would appear empty for the entire Xavia catalogue.
  //
  // Pagination: page+pageSize (1-indexed) instead of cursor — merging
  // two heterogeneous cursors with stable ordering is a footgun. The
  // dataset size today (low thousands) is well within the OFFSET-
  // scan envelope; MC.2 swaps to keyset pagination if profiling
  // shows the merge as the bottleneck.
  //
  // Filtering: `type` narrows to image/video/document/model3d. Note
  // ProductImage rows are always type='image' so a type=video filter
  // implicitly excludes them. `search` matches filename/label/alt
  // case-insensitively across both tables.
  fastify.get('/assets/library', async (request) => {
    const q = request.query as {
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
    }
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
  })

  // MC.1.5 — unified detail endpoint for the library drawer.
  //
  // Accepts the "da_<id>" / "pi_<id>" prefix from /assets/library and
  // returns a normalised AssetDetail that the drawer can render
  // without branching on the source. ProductImage rows surface their
  // single product attachment as a synthetic usage so the "Used in"
  // section has the same shape regardless of source.
  fastify.get('/assets/library/:id', async (request, reply) => {
    const { id: prefixed } = request.params as { id: string }
    if (prefixed.startsWith('da_')) {
      const id = prefixed.slice(3)
      const asset = await prisma.digitalAsset.findUnique({
        where: { id },
        include: {
          usages: {
            include: {
              product: { select: { id: true, sku: true, name: true } },
            },
            orderBy: [{ role: 'asc' }, { sortOrder: 'asc' }],
          },
          tags: {
            include: { tag: true },
          },
        },
      })
      if (!asset) return reply.code(404).send({ error: 'asset not found' })
      const meta =
        (asset.metadata as Record<string, unknown> | null) ?? {}
      return {
        detail: {
          id: prefixed,
          source: 'digital_asset' as const,
          url: asset.url,
          label: asset.label,
          code: asset.code,
          type: asset.type,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          width: typeof meta.width === 'number' ? meta.width : null,
          height: typeof meta.height === 'number' ? meta.height : null,
          alt: typeof meta.alt === 'string' ? meta.alt : null,
          caption: typeof meta.caption === 'string' ? meta.caption : null,
          // MC.2.1 — surface AssetTag rows alongside metadata.tags
          // (the JSON freeform field). Operator-set tags via the
          // picker live in AssetTag; AI-suggested tags go into
          // metadata.tags until reviewed and promoted. Here we
          // return both — typed (`assetTags`) and legacy (`tags`).
          assetTags: asset.tags.map((at) => ({
            id: at.tag.id,
            name: at.tag.name,
            color: at.tag.color,
          })),
          tags: Array.isArray(meta.tags)
            ? (meta.tags.filter((t) => typeof t === 'string') as string[])
            : [],
          originalFilename: asset.originalFilename,
          storageProvider: asset.storageProvider,
          storageId: asset.storageId,
          createdAt: asset.createdAt.toISOString(),
          updatedAt: asset.updatedAt.toISOString(),
          usages: asset.usages.map((u) => ({
            id: u.id,
            scope: u.scope,
            role: u.role,
            sortOrder: u.sortOrder,
            productId: u.product?.id ?? null,
            productSku: u.product?.sku ?? null,
            productName: u.product?.name ?? null,
          })),
        },
      }
    }
    if (prefixed.startsWith('pi_')) {
      const id = prefixed.slice(3)
      const row = await prisma.productImage.findUnique({
        where: { id },
        include: {
          product: { select: { id: true, sku: true, name: true } },
        },
      })
      if (!row) return reply.code(404).send({ error: 'asset not found' })
      return {
        detail: {
          id: prefixed,
          source: 'product_image' as const,
          url: row.url,
          label: row.alt || row.publicId || row.product?.sku || 'Untitled',
          code: null,
          type: 'image',
          mimeType: null,
          sizeBytes: null,
          width: null,
          height: null,
          alt: row.alt,
          caption: null,
          // ProductImage rows can't be tagged today (legacy gallery,
          // not the W4.5 canonical model). Returning empty arrays
          // keeps the drawer's render branch source-agnostic.
          assetTags: [] as Array<{
            id: string
            name: string
            color: string | null
          }>,
          tags: [],
          originalFilename: null,
          storageProvider: row.publicId ? 'cloudinary' : 'external',
          storageId: row.publicId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          usages: [
            // Synthetic usage so the drawer's "Used in" section has
            // a consistent shape across both sources.
            {
              id: `pi_usage_${row.id}`,
              scope: 'product',
              role: row.type.toLowerCase(),
              sortOrder: row.sortOrder,
              productId: row.product?.id ?? null,
              productSku: row.product?.sku ?? null,
              productName: row.product?.name ?? null,
            },
          ],
        },
      }
    }
    return reply.code(400).send({
      error:
        'id must be prefixed with "da_" (digital asset) or "pi_" (product image)',
    })
  })

  fastify.get('/assets', async (request) => {
    const q = request.query as {
      type?: string
      search?: string
      limit?: string
      cursor?: string
    }
    const limit = Math.min(
      Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
      200,
    )
    const where: Record<string, unknown> = {}
    if (q.type && VALID_ASSET_TYPES.has(q.type)) where.type = q.type
    if (q.search?.trim()) {
      const s = q.search.trim()
      where.OR = [
        { label: { contains: s, mode: 'insensitive' } },
        { code: { contains: s, mode: 'insensitive' } },
        { originalFilename: { contains: s, mode: 'insensitive' } },
      ]
    }

    const assets = await prisma.digitalAsset.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: {
        _count: { select: { usages: true } },
      },
    })
    const hasMore = assets.length > limit
    const trimmed = hasMore ? assets.slice(0, limit) : assets
    return {
      assets: trimmed,
      nextCursor: hasMore ? trimmed[trimmed.length - 1]?.id ?? null : null,
    }
  })

  fastify.get('/assets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const asset = await prisma.digitalAsset.findUnique({
      where: { id },
      include: {
        usages: {
          include: {
            product: {
              select: { id: true, sku: true, name: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
    if (!asset) return reply.code(404).send({ error: 'asset not found' })
    return { asset }
  })

  fastify.post('/assets', async (request, reply) => {
    const body = request.body as {
      label?: string
      code?: string | null
      type?: string
      mimeType?: string
      sizeBytes?: number
      storageProvider?: string
      storageId?: string
      url?: string
      originalFilename?: string | null
      metadata?: unknown
    }
    if (!body.label?.trim())
      return reply.code(400).send({ error: 'label is required' })
    if (!body.mimeType)
      return reply.code(400).send({ error: 'mimeType is required' })
    if (typeof body.sizeBytes !== 'number' || body.sizeBytes < 0)
      return reply
        .code(400)
        .send({ error: 'sizeBytes is required and must be >= 0' })
    if (!body.storageId)
      return reply.code(400).send({ error: 'storageId is required' })
    if (!body.url)
      return reply.code(400).send({ error: 'url is required' })
    const type = body.type ?? 'image'
    if (!VALID_ASSET_TYPES.has(type))
      return reply.code(400).send({
        error: `type must be one of ${[...VALID_ASSET_TYPES].join(', ')}`,
      })
    if (body.code && !CODE_PATTERN.test(body.code))
      return reply.code(400).send({
        error: 'code (when provided) must be lowercase snake_case',
      })

    try {
      const asset = await prisma.digitalAsset.create({
        data: {
          label: body.label.trim(),
          code: body.code || null,
          type,
          mimeType: body.mimeType,
          sizeBytes: body.sizeBytes,
          storageProvider: body.storageProvider ?? 'cloudinary',
          storageId: body.storageId,
          url: body.url,
          originalFilename: body.originalFilename ?? null,
          metadata: (body.metadata as never) ?? null,
        },
      })
      return reply.code(201).send({ asset })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply
          .code(409)
          .send({ error: `asset code "${body.code}" already exists` })
      throw err
    }
  })

  fastify.patch('/assets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      label?: string
      code?: string | null
      metadata?: unknown
    }
    // storageProvider/storageId/url/mimeType/sizeBytes/type
    // intentionally immutable — to "swap" the underlying file the
    // operator should re-upload + create a new asset + re-attach
    // usages. Keeps the audit story clean.
    const data: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (!body.label.trim())
        return reply.code(400).send({ error: 'label cannot be empty' })
      data.label = body.label.trim()
    }
    if (body.code !== undefined) {
      if (body.code && !CODE_PATTERN.test(body.code))
        return reply.code(400).send({
          error: 'code (when provided) must be lowercase snake_case',
        })
      data.code = body.code || null
    }
    if (body.metadata !== undefined)
      data.metadata = (body.metadata as never) ?? null
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const asset = await prisma.digitalAsset.update({ where: { id }, data })
      return { asset }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'asset not found' })
      if (err?.code === 'P2002')
        return reply
          .code(409)
          .send({ error: `asset code "${body.code}" already exists` })
      throw err
    }
  })

  fastify.delete('/assets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.digitalAsset.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'asset not found' })
      throw err
    }
  })

  // ── AssetUsage ──────────────────────────────────────────────

  fastify.post('/products/:id/asset-usages', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const body = request.body as {
      assetId?: string
      role?: string
      sortOrder?: number
    }
    if (!body.assetId)
      return reply.code(400).send({ error: 'assetId is required' })
    if (!body.role?.trim())
      return reply.code(400).send({ error: 'role is required' })

    const [asset, product] = await Promise.all([
      prisma.digitalAsset.findUnique({
        where: { id: body.assetId },
        select: { id: true },
      }),
      prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      }),
    ])
    if (!asset)
      return reply.code(400).send({ error: 'assetId does not exist' })
    if (!product)
      return reply.code(404).send({ error: 'product not found' })

    try {
      const usage = await prisma.assetUsage.create({
        data: {
          assetId: body.assetId,
          scope: 'product',
          productId,
          role: body.role.trim(),
          sortOrder:
            typeof body.sortOrder === 'number' ? body.sortOrder : 0,
        },
        include: {
          asset: { select: { id: true, label: true, type: true, url: true } },
        },
      })
      return reply.code(201).send({ usage })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply.code(409).send({
          error:
            'this asset is already attached to this product in the same role + slot — pick a different role or sortOrder',
        })
      throw err
    }
  })

  fastify.patch('/asset-usages/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { role?: string; sortOrder?: number }
    const data: Record<string, unknown> = {}
    if (body.role !== undefined) {
      if (!body.role.trim())
        return reply.code(400).send({ error: 'role cannot be empty' })
      data.role = body.role.trim()
    }
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const usage = await prisma.assetUsage.update({ where: { id }, data })
      return { usage }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'asset-usage not found' })
      if (err?.code === 'P2002')
        return reply.code(409).send({
          error:
            'another usage already occupies this role + sortOrder for the same asset + product',
        })
      throw err
    }
  })

  fastify.delete('/asset-usages/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.assetUsage.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'asset-usage not found' })
      throw err
    }
  })

  // ── MC.2.1 — AssetTag CRUD ─────────────────────────────────

  // List all tags. Includes asset count alongside the existing
  // product/order counts so the operator can see which tags are
  // actually used by the DAM. This duplicates a thin slice of the
  // /tags endpoint that already exists elsewhere; consolidating is a
  // follow-up. Returning here keeps /marketing/content's network
  // surface contained.
  fastify.get('/asset-tags', async () => {
    const tags = await prisma.tag.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { assets: true, products: true, orders: true },
        },
      },
    })
    return { tags }
  })

  // Replace the tag set on a DigitalAsset. Body is { tagIds: [...] }
  // or { tagNames: [...] } — name form auto-creates tags that don't
  // yet exist (operator-friendly; common-case is "type a new tag in
  // the picker"). Returns the updated tag list so the drawer can
  // render without re-fetching.
  fastify.put('/assets/:id/tags', async (request, reply) => {
    const { id: assetId } = request.params as { id: string }
    const body = request.body as {
      tagIds?: string[]
      tagNames?: string[]
    }
    const asset = await prisma.digitalAsset.findUnique({
      where: { id: assetId },
      select: { id: true },
    })
    if (!asset)
      return reply.code(404).send({ error: 'asset not found' })

    const idSet = new Set(body.tagIds ?? [])

    // Resolve names → ids, creating any that don't exist. createMany
    // with skipDuplicates would be cleaner but doesn't return rows;
    // upsert one-by-one is fine here because the picker shouldn't
    // routinely create more than a handful.
    if (body.tagNames?.length) {
      for (const rawName of body.tagNames) {
        const name = rawName.trim()
        if (!name) continue
        const existing = await prisma.tag.findUnique({ where: { name } })
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

    const tags = await prisma.tag.findMany({
      where: { id: { in: tagIds } },
      orderBy: { name: 'asc' },
    })
    return { tags }
  })

  // ── MC.2.2 — AssetFolder CRUD + tree ───────────────────────

  // Returns the entire folder tree as a flat list with parentId. The
  // operator's tree usually fits in a single response (< 1k folders
  // even at large catalogs), and the client renders the tree
  // structure off the parentId pointers. If the workspace ever
  // outgrows that, MC.2-followup paginates by depth.
  fastify.get('/asset-folders', async () => {
    const folders = await prisma.assetFolder.findMany({
      orderBy: [{ parentId: 'asc' }, { order: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { assets: true, children: true } },
      },
    })
    return { folders }
  })

  fastify.post('/asset-folders', async (request, reply) => {
    const body = request.body as {
      name?: string
      parentId?: string | null
      order?: number
    }
    if (!body.name?.trim())
      return reply.code(400).send({ error: 'name is required' })

    if (body.parentId) {
      const parent = await prisma.assetFolder.findUnique({
        where: { id: body.parentId },
        select: { id: true },
      })
      if (!parent)
        return reply.code(400).send({ error: 'parentId does not exist' })
    }

    const folder = await prisma.assetFolder.create({
      data: {
        name: body.name.trim(),
        parentId: body.parentId ?? null,
        order: typeof body.order === 'number' ? body.order : 0,
      },
    })
    return reply.code(201).send({ folder })
  })

  fastify.patch('/asset-folders/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      name?: string
      parentId?: string | null
      order?: number
    }
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) {
      if (!body.name.trim())
        return reply.code(400).send({ error: 'name cannot be empty' })
      data.name = body.name.trim()
    }
    if (body.parentId !== undefined) {
      // Prevent cycles — a folder can't be its own ancestor. Walk
      // up the requested parent's chain; if we hit `id` first, the
      // move would create a cycle.
      if (body.parentId === id)
        return reply
          .code(400)
          .send({ error: 'cannot make a folder its own parent' })
      if (body.parentId) {
        let cursor: string | null = body.parentId
        for (let i = 0; i < 32 && cursor; i++) {
          if (cursor === id)
            return reply.code(400).send({
              error:
                'cycle detected — moving here would put a folder inside its own subtree',
            })
          const parent = await prisma.assetFolder.findUnique({
            where: { id: cursor },
            select: { parentId: true },
          })
          if (!parent) break
          cursor = parent.parentId
        }
      }
      data.parentId = body.parentId ?? null
    }
    if (body.order !== undefined) data.order = body.order
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const folder = await prisma.assetFolder.update({
        where: { id },
        data,
      })
      return { folder }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'folder not found' })
      throw err
    }
  })

  fastify.delete('/asset-folders/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.assetFolder.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'folder not found' })
      throw err
    }
  })

  // ── MC.3.1 — direct upload (multipart) ─────────────────────

  fastify.post('/assets/upload', async (request, reply) => {
    if (!isCloudinaryConfigured())
      return reply.code(503).send({
        error:
          'Storage is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.',
      })

    const part = await request.file()
    if (!part) return reply.code(400).send({ error: 'no file uploaded' })

    if (!UPLOAD_IMAGE_MIME_TYPES.has(part.mimetype))
      return reply.code(400).send({
        error: `unsupported mime type "${part.mimetype}". Allowed: ${[...UPLOAD_IMAGE_MIME_TYPES].join(', ')}`,
      })

    // Pull the multipart fields out of the form-data body. fastify-
    // multipart returns the file as `part`, plus any non-file fields
    // on `part.fields` keyed by name.
    const fields = part.fields as Record<
      string,
      { value: string } | undefined
    >
    const folderId = fields?.folderId?.value || null
    const labelOverride = fields?.label?.value?.trim() || null

    if (folderId) {
      const folder = await prisma.assetFolder.findUnique({
        where: { id: folderId },
        select: { id: true },
      })
      if (!folder)
        return reply.code(400).send({ error: 'folderId does not exist' })
    }

    // Stream-to-buffer with a hard cap. fastify-multipart already has
    // a `limits.fileSize` knob but its enforcement is async and we
    // get a partial buffer back; checking length post-toBuffer is
    // belt-and-braces.
    const buffer = await part.toBuffer()
    if (buffer.length > MAX_UPLOAD_BYTES)
      return reply.code(413).send({
        error: `file exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
        size: buffer.length,
      })

    const folder = folderId
      ? `marketing-content/${folderId}`
      : 'marketing-content/unfiled'

    let cloudResult
    try {
      cloudResult = await uploadBufferToCloudinary(buffer, { folder })
    } catch (err) {
      return reply.code(502).send({
        error: 'storage upload failed',
        detail: err instanceof Error ? err.message : 'unknown',
      })
    }

    const asset = await prisma.digitalAsset.create({
      data: {
        label: labelOverride ?? part.filename ?? 'Untitled',
        type: 'image',
        mimeType: part.mimetype,
        sizeBytes: cloudResult.bytes,
        storageProvider: 'cloudinary',
        storageId: cloudResult.publicId,
        url: cloudResult.url,
        originalFilename: part.filename ?? null,
        folderId,
        metadata: {
          width: cloudResult.width,
          height: cloudResult.height,
          format: cloudResult.format,
        },
      },
    })

    return reply.code(201).send({ asset })
  })

  // MC.3.1 — upload-from-URL.
  //
  // Operator pastes a public URL (Amazon CDN, supplier site, Google
  // Drive direct link) and the server fetches it, validates it, and
  // pushes to Cloudinary. Saves the operator from a download-then-
  // upload roundtrip and lets us auto-import from listings on other
  // marketplaces.
  fastify.post('/assets/upload-url', async (request, reply) => {
    if (!isCloudinaryConfigured())
      return reply.code(503).send({ error: 'Storage is not configured.' })

    const body = request.body as {
      url?: string
      label?: string
      folderId?: string | null
    }
    if (!body.url?.trim())
      return reply.code(400).send({ error: 'url is required' })
    let parsed: URL
    try {
      parsed = new URL(body.url.trim())
    } catch {
      return reply.code(400).send({ error: 'url is not a valid URL' })
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      return reply
        .code(400)
        .send({ error: 'url must be http(s)' })

    if (body.folderId) {
      const folder = await prisma.assetFolder.findUnique({
        where: { id: body.folderId },
        select: { id: true },
      })
      if (!folder)
        return reply.code(400).send({ error: 'folderId does not exist' })
    }

    let res: Response
    try {
      res = await fetch(parsed.toString(), {
        // 15s cap; longer fetches go through the bulk flow.
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      })
    } catch (err) {
      return reply.code(502).send({
        error: 'failed to fetch the URL',
        detail: err instanceof Error ? err.message : 'unknown',
      })
    }
    if (!res.ok)
      return reply
        .code(502)
        .send({ error: `source URL returned ${res.status}` })

    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim()
    if (!mimeType || !UPLOAD_IMAGE_MIME_TYPES.has(mimeType))
      return reply
        .code(400)
        .send({ error: `unsupported content-type "${mimeType ?? 'unknown'}"` })

    const arrayBuffer = await res.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES)
      return reply.code(413).send({
        error: `remote file exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
        size: arrayBuffer.byteLength,
      })

    const buffer = Buffer.from(arrayBuffer)
    const folder = body.folderId
      ? `marketing-content/${body.folderId}`
      : 'marketing-content/unfiled'

    let cloudResult
    try {
      cloudResult = await uploadBufferToCloudinary(buffer, { folder })
    } catch (err) {
      return reply.code(502).send({
        error: 'storage upload failed',
        detail: err instanceof Error ? err.message : 'unknown',
      })
    }

    const filename =
      decodeURIComponent(parsed.pathname.split('/').pop() ?? '') ||
      `import-${Date.now()}`

    const asset = await prisma.digitalAsset.create({
      data: {
        label: body.label?.trim() || filename,
        type: 'image',
        mimeType,
        sizeBytes: cloudResult.bytes,
        storageProvider: 'cloudinary',
        storageId: cloudResult.publicId,
        url: cloudResult.url,
        originalFilename: filename,
        folderId: body.folderId ?? null,
        metadata: {
          width: cloudResult.width,
          height: cloudResult.height,
          format: cloudResult.format,
          source: 'url_import',
          sourceUrl: parsed.toString(),
        },
      },
    })

    return reply.code(201).send({ asset })
  })

  // Move a set of assets to a folder (or to "unfiled" via folderId
  // null). Used by the bulk Move action; also handles single-asset
  // moves from the detail drawer.
  fastify.post('/assets/move', async (request, reply) => {
    const body = request.body as {
      assetIds?: string[]
      folderId?: string | null
    }
    if (!Array.isArray(body.assetIds) || body.assetIds.length === 0)
      return reply
        .code(400)
        .send({ error: 'assetIds array is required (1+ ids)' })

    if (body.folderId) {
      const folder = await prisma.assetFolder.findUnique({
        where: { id: body.folderId },
        select: { id: true },
      })
      if (!folder)
        return reply.code(400).send({ error: 'folderId does not exist' })
    }

    const updated = await prisma.digitalAsset.updateMany({
      where: { id: { in: body.assetIds } },
      data: { folderId: body.folderId ?? null },
    })
    return { moved: updated.count, folderId: body.folderId ?? null }
  })
}

export default assetsRoutes
