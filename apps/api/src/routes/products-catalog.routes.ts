import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

// ─────────────────────────────────────────────────────────────────────
// PRODUCTS REBUILD C.2 — catalog browse extensions
//
// Facets        GET  /api/products/facets        distinct productTypes,
//                                                brands, fulfillment for
//                                                filter chips
// Health        GET  /api/products/:id/health    photos + listings + sync
// Tags          GET  /api/tags                   list + per-product counts
//               POST /api/tags
//               PATCH /api/tags/:id
//               DELETE /api/tags/:id
//               POST /api/products/:id/tags      attach
//               DELETE /api/products/:id/tags/:tagId
//               POST /api/products/bulk-tag      attach to N products
// Bundles       GET  /api/bundles                list with components
//               POST /api/bundles
//               GET  /api/bundles/:id
//               PATCH /api/bundles/:id
//               DELETE /api/bundles/:id
// Saved views   GET  /api/saved-views?surface=products
//               POST /api/saved-views
//               PATCH /api/saved-views/:id
//               DELETE /api/saved-views/:id
//               POST /api/saved-views/:id/set-default
// ─────────────────────────────────────────────────────────────────────

// Single-tenant: derive a stable userId from the request. When auth lands
// this becomes req.user.id. For now everyone shares "default-user".
function userIdFor(_req: any): string {
  return 'default-user'
}

const productsCatalogRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════════════════════════════════════════════════════════════
  // FACETS
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/products/facets', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=60')
      const [productTypes, brands, fulfillment, statusCounts] = await Promise.all([
        prisma.product.groupBy({
          by: ['productType'],
          where: { parentId: null, productType: { not: null } },
          _count: true,
        }),
        prisma.product.groupBy({
          by: ['brand'],
          where: { parentId: null, brand: { not: null } },
          _count: true,
        }),
        prisma.product.groupBy({
          by: ['fulfillmentMethod'],
          where: { parentId: null, fulfillmentMethod: { not: null } },
          _count: true,
        }),
        prisma.product.groupBy({
          by: ['status'],
          where: { parentId: null },
          _count: true,
        }),
      ])

      return {
        productTypes: productTypes
          .filter((p) => p.productType)
          .map((p) => ({ value: p.productType!, count: p._count }))
          .sort((a, b) => b.count - a.count),
        brands: brands
          .filter((b) => b.brand)
          .map((b) => ({ value: b.brand!, count: b._count }))
          .sort((a, b) => b.count - a.count),
        fulfillment: fulfillment
          .filter((f) => f.fulfillmentMethod)
          .map((f) => ({ value: f.fulfillmentMethod!, count: f._count })),
        statuses: statusCounts.map((s) => ({ value: s.status, count: s._count })),
      }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // HEALTH (per product)
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/products/:id/health', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const p = await prisma.product.findUnique({
        where: { id },
        select: {
          id: true, sku: true, name: true, totalStock: true, lowStockThreshold: true,
          description: true, bulletPoints: true, gtin: true, upc: true, ean: true, brand: true,
          productType: true,
          _count: { select: { images: true, channelListings: true, variations: true } },
          channelListings: {
            select: {
              id: true, channel: true, marketplace: true, listingStatus: true,
              syncStatus: true, lastSyncStatus: true, lastSyncError: true,
              isPublished: true, validationStatus: true, validationErrors: true,
            },
          },
        },
      })
      if (!p) return reply.code(404).send({ error: 'Product not found' })

      // Build a list of issues with severity
      const issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; channel?: string; marketplace?: string }> = []

      // Master-data warnings
      if (!p.description) issues.push({ severity: 'warning', message: 'Missing description' })
      if (!p.bulletPoints || p.bulletPoints.length === 0) issues.push({ severity: 'warning', message: 'No bullet points' })
      if (!p.gtin && !p.upc && !p.ean) issues.push({ severity: 'warning', message: 'No GTIN/UPC/EAN' })
      if (!p.brand) issues.push({ severity: 'info', message: 'No brand set' })
      if (!p.productType) issues.push({ severity: 'info', message: 'No productType set' })
      if (p._count.images === 0) issues.push({ severity: 'error', message: 'No images uploaded' })
      else if (p._count.images < 3) issues.push({ severity: 'warning', message: `Only ${p._count.images} image(s) — channels typically require 3+` })

      // Stock warnings
      if (p.totalStock === 0) issues.push({ severity: 'error', message: 'Out of stock' })
      else if (p.totalStock <= p.lowStockThreshold) issues.push({ severity: 'warning', message: `Low stock (${p.totalStock} left)` })

      // Per-channel-listing issues
      let liveCount = 0, draftCount = 0, errorCount = 0
      for (const cl of p.channelListings) {
        if (cl.listingStatus === 'ACTIVE' && cl.isPublished) liveCount++
        else if (cl.listingStatus === 'DRAFT') draftCount++
        if (cl.listingStatus === 'ERROR' || cl.lastSyncStatus === 'FAILED' || cl.syncStatus === 'FAILED') {
          errorCount++
          issues.push({
            severity: 'error',
            message: cl.lastSyncError ?? `${cl.channel} sync failed`,
            channel: cl.channel,
            marketplace: cl.marketplace,
          })
        }
        if (cl.validationStatus === 'ERROR' && cl.validationErrors && cl.validationErrors.length > 0) {
          for (const ve of cl.validationErrors.slice(0, 3)) {
            issues.push({ severity: 'warning', message: ve, channel: cl.channel, marketplace: cl.marketplace })
          }
        }
      }

      // Composite score 0..100. Each error -10, each warning -3, each info -1, capped at 0.
      const score = Math.max(
        0,
        100 -
          issues.filter((i) => i.severity === 'error').length * 10 -
          issues.filter((i) => i.severity === 'warning').length * 3 -
          issues.filter((i) => i.severity === 'info').length * 1,
      )

      return {
        productId: p.id,
        sku: p.sku,
        score,
        photoCount: p._count.images,
        channelCount: p._count.channelListings,
        variantCount: p._count.variations,
        liveCount,
        draftCount,
        errorCount,
        issues,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[products/:id/health] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // TAGS
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/tags', async (_request, reply) => {
    try {
      const tags = await prisma.tag.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { products: true } } },
      })
      return {
        items: tags.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
          productCount: t._count.products,
          updatedAt: t.updatedAt,
        })),
      }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/tags', async (request, reply) => {
    try {
      const body = request.body as { name?: string; color?: string }
      if (!body.name?.trim()) return reply.code(400).send({ error: 'name required' })
      const tag = await prisma.tag.create({
        data: { name: body.name.trim(), color: body.color ?? null },
      })
      return tag
    } catch (err: any) {
      if (err?.code === 'P2002') return reply.code(409).send({ error: 'Tag name already exists' })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.patch('/tags/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { name?: string; color?: string }
      const tag = await prisma.tag.update({
        where: { id },
        data: { name: body.name, color: body.color ?? null },
      })
      return tag
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/tags/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.tag.delete({ where: { id } })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/products/:id/tags', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { tagIds?: string[] }
      const tagIds = Array.isArray(body.tagIds) ? body.tagIds : []
      for (const tagId of tagIds) {
        await prisma.productTag.upsert({
          where: { productId_tagId: { productId: id, tagId } },
          update: {},
          create: { productId: id, tagId },
        })
      }
      const current = await prisma.productTag.findMany({
        where: { productId: id },
        include: { tag: true },
      })
      return { tags: current.map((c) => c.tag) }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/products/:id/tags/:tagId', async (request, reply) => {
    try {
      const { id, tagId } = request.params as { id: string; tagId: string }
      await prisma.productTag.delete({
        where: { productId_tagId: { productId: id, tagId } },
      })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/products/bulk-tag', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[]; tagIds?: string[]; mode?: 'add' | 'remove' }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      const tagIds = Array.isArray(body.tagIds) ? body.tagIds : []
      const mode = body.mode === 'remove' ? 'remove' : 'add'
      if (productIds.length === 0 || tagIds.length === 0) {
        return reply.code(400).send({ error: 'productIds[] + tagIds[] required' })
      }
      let touched = 0
      for (const productId of productIds) {
        for (const tagId of tagIds) {
          if (mode === 'add') {
            await prisma.productTag.upsert({
              where: { productId_tagId: { productId, tagId } },
              update: {},
              create: { productId, tagId },
            })
          } else {
            await prisma.productTag.deleteMany({
              where: { productId, tagId },
            })
          }
          touched++
        }
      }
      return { ok: true, mode, touched }
    } catch (err: any) {
      fastify.log.error({ err }, '[products/bulk-tag] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // BUNDLES
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/bundles', async (_request, reply) => {
    try {
      const bundles = await prisma.bundle.findMany({
        include: {
          components: {
            include: {
              // No FK to Product on BundleComponent — fetch product details manually below
            } as any,
          },
        },
        orderBy: { updatedAt: 'desc' },
      })
      // Hydrate component products
      const allProductIds = new Set<string>()
      for (const b of bundles) {
        allProductIds.add(b.productId)
        for (const c of b.components) allProductIds.add(c.productId)
      }
      const productList = await prisma.product.findMany({
        where: { id: { in: Array.from(allProductIds) } },
        select: { id: true, sku: true, name: true, basePrice: true, totalStock: true },
      })
      const productMap = new Map(productList.map((p) => [p.id, p]))

      return {
        items: bundles.map((b) => ({
          id: b.id,
          productId: b.productId,
          name: b.name,
          description: b.description,
          isActive: b.isActive,
          computedCostCents: b.computedCostCents,
          wrapperProduct: productMap.get(b.productId) ?? null,
          components: b.components.map((c) => ({
            id: c.id,
            productId: c.productId,
            quantity: c.quantity,
            unitCostCents: c.unitCostCents,
            product: productMap.get(c.productId) ?? null,
          })),
          // Computed available stock = min over components of (stock / qty)
          availableStock: b.components.length === 0
            ? 0
            : Math.min(...b.components.map((c) => {
                const p = productMap.get(c.productId)
                return Math.floor((p?.totalStock ?? 0) / Math.max(1, c.quantity))
              })),
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[bundles list] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/bundles', async (request, reply) => {
    try {
      const body = request.body as {
        productId?: string
        name?: string
        description?: string
        components?: Array<{ productId: string; quantity?: number; unitCostCents?: number }>
      }
      if (!body.productId || !body.name) return reply.code(400).send({ error: 'productId + name required' })
      const components = Array.isArray(body.components) ? body.components : []

      const bundle = await prisma.bundle.create({
        data: {
          productId: body.productId,
          name: body.name,
          description: body.description ?? null,
          components: {
            create: components.map((c) => ({
              productId: c.productId,
              quantity: c.quantity ?? 1,
              unitCostCents: c.unitCostCents ?? null,
            })),
          },
        },
        include: { components: true },
      })
      return bundle
    } catch (err: any) {
      if (err?.code === 'P2002') return reply.code(409).send({ error: 'Product is already a bundle' })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.get('/bundles/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const bundle = await prisma.bundle.findUnique({
      where: { id },
      include: { components: true },
    })
    if (!bundle) return reply.code(404).send({ error: 'Bundle not found' })
    return bundle
  })

  fastify.patch('/bundles/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        name?: string
        description?: string
        isActive?: boolean
        components?: Array<{ productId: string; quantity?: number; unitCostCents?: number }>
      }
      const updates: any = {}
      if (body.name != null) updates.name = body.name
      if (body.description != null) updates.description = body.description
      if (body.isActive != null) updates.isActive = body.isActive
      if (body.components) {
        // Replace components atomically
        await prisma.bundleComponent.deleteMany({ where: { bundleId: id } })
        updates.components = {
          create: body.components.map((c) => ({
            productId: c.productId,
            quantity: c.quantity ?? 1,
            unitCostCents: c.unitCostCents ?? null,
          })),
        }
      }
      const bundle = await prisma.bundle.update({
        where: { id },
        data: updates,
        include: { components: true },
      })
      return bundle
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/bundles/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.bundle.delete({ where: { id } })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // SAVED VIEWS
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/saved-views', async (request, reply) => {
    try {
      const q = request.query as { surface?: string }
      const userId = userIdFor(request)
      const views = await prisma.savedView.findMany({
        where: { userId, surface: q.surface ?? 'products' },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      })
      return { items: views }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/saved-views', async (request, reply) => {
    try {
      const body = request.body as { name?: string; surface?: string; filters?: any; isDefault?: boolean }
      if (!body.name?.trim()) return reply.code(400).send({ error: 'name required' })
      const userId = userIdFor(request)
      // Setting isDefault clears the previous default for this (user, surface)
      if (body.isDefault) {
        await prisma.savedView.updateMany({
          where: { userId, surface: body.surface ?? 'products' },
          data: { isDefault: false },
        })
      }
      const view = await prisma.savedView.create({
        data: {
          userId,
          surface: body.surface ?? 'products',
          name: body.name.trim(),
          filters: body.filters ?? {},
          isDefault: !!body.isDefault,
        },
      })
      return view
    } catch (err: any) {
      if (err?.code === 'P2002') return reply.code(409).send({ error: 'A view with this name already exists' })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.patch('/saved-views/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { name?: string; filters?: any; isDefault?: boolean }
      const userId = userIdFor(request)
      const existing = await prisma.savedView.findFirst({ where: { id, userId } })
      if (!existing) return reply.code(404).send({ error: 'View not found' })
      if (body.isDefault) {
        await prisma.savedView.updateMany({
          where: { userId, surface: existing.surface, id: { not: id } },
          data: { isDefault: false },
        })
      }
      const view = await prisma.savedView.update({
        where: { id },
        data: {
          name: body.name ?? existing.name,
          filters: body.filters ?? (existing.filters as any),
          isDefault: body.isDefault ?? existing.isDefault,
        },
      })
      return view
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/saved-views/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const userId = userIdFor(request)
      await prisma.savedView.deleteMany({ where: { id, userId } })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // BULK CATALOG ACTIONS — promote to parent / attach as child / set status
  // (Bulk publish to channels uses /api/listings/bulk-action which already
  // exists; this is for product-level actions.)
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/products/bulk-status', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[]; status?: string }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      const status = (body.status ?? '').toUpperCase()
      if (productIds.length === 0) return reply.code(400).send({ error: 'productIds[] required' })
      if (!['ACTIVE', 'DRAFT', 'INACTIVE'].includes(status)) {
        return reply.code(400).send({ error: 'status must be ACTIVE | DRAFT | INACTIVE' })
      }
      const result = await prisma.product.updateMany({
        where: { id: { in: productIds } },
        data: { status, version: { increment: 1 } },
      })
      return { ok: true, updated: result.count }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/products/bulk-duplicate', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[] }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      if (productIds.length === 0) return reply.code(400).send({ error: 'productIds[] required' })
      if (productIds.length > 50) return reply.code(400).send({ error: 'Max 50 duplicates per call' })
      const sources = await prisma.product.findMany({ where: { id: { in: productIds } } })
      const cloned = []
      for (const src of sources) {
        const stamp = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`
        cloned.push(
          await prisma.product.create({
            data: {
              sku: `${src.sku}-COPY-${stamp}`,
              name: `${src.name} (copy)`,
              basePrice: src.basePrice,
              totalStock: 0,
              status: 'DRAFT',
              brand: src.brand,
              productType: src.productType,
              fulfillmentMethod: src.fulfillmentMethod,
              description: src.description,
              bulletPoints: src.bulletPoints,
              keywords: src.keywords,
              categoryAttributes: (src.categoryAttributes as any) ?? null,
            },
          }),
        )
      }
      return { ok: true, created: cloned.length, products: cloned.map((c) => ({ id: c.id, sku: c.sku })) }
    } catch (err: any) {
      fastify.log.error({ err }, '[bulk-duplicate] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // PATCH /api/products/:id — small whitelisted update for inline
  // quick-edit cells in the Grid lens. Avoids re-using the heavy
  // /products/bulk endpoint which is geared at the bulk-operations grid.
  fastify.patch('/products/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as any
      const allowed = [
        'name', 'basePrice', 'totalStock', 'lowStockThreshold',
        'status', 'fulfillmentMethod', 'brand', 'productType',
        'description',
      ]
      const data: any = { version: { increment: 1 } }
      for (const k of allowed) {
        if (body[k] !== undefined) {
          if (k === 'basePrice') data.basePrice = Number(body.basePrice)
          else if (k === 'totalStock' || k === 'lowStockThreshold') data[k] = Math.max(0, Math.floor(Number(body[k]) || 0))
          else if (k === 'fulfillmentMethod') data[k] = body[k] || null
          else data[k] = body[k]
        }
      }
      const updated = await prisma.product.update({
        where: { id },
        data,
        select: {
          id: true, sku: true, name: true, basePrice: true, totalStock: true,
          lowStockThreshold: true, status: true, fulfillmentMethod: true,
          brand: true, productType: true, version: true, updatedAt: true,
        },
      })
      return {
        ...updated,
        basePrice: Number(updated.basePrice),
      }
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Product not found' })
      fastify.log.error({ err }, '[PATCH /products/:id] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/products/bulk-set-stock', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[]; totalStock?: number; lowStockThreshold?: number }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      if (productIds.length === 0) return reply.code(400).send({ error: 'productIds[] required' })
      const data: any = { version: { increment: 1 } }
      if (typeof body.totalStock === 'number') data.totalStock = body.totalStock
      if (typeof body.lowStockThreshold === 'number') data.lowStockThreshold = body.lowStockThreshold
      const result = await prisma.product.updateMany({
        where: { id: { in: productIds } },
        data,
      })
      return { ok: true, updated: result.count }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })
}

export default productsCatalogRoutes
