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

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const VALID_ASSET_TYPES = new Set(['image', 'video', 'document', 'model3d'])

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
}

export default assetsRoutes
