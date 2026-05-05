/**
 * AAA — PIM organization endpoints for the rebuilt /pim/review.
 *
 * Layout:
 *   GET  /pim/standalones        — paginated non-parented products
 *   GET  /pim/parents-overview   — paginated parents with stats
 *   POST /pim/attach-to-parent   — link orphans under one parent
 *   POST /pim/promote-to-parent  — flip isParent=true on an orphan
 *
 * Existing detect-groups + apply-groups endpoints stay where they
 * are (apps/api/src/routes/amazon.routes.ts). Tab 1 keeps using
 * those — this file only adds the new "standalones / parents"
 * surface.
 *
 * Each write endpoint:
 *   - Idempotency-Key header dedups via NN.2 idempotencyService
 *   - Audit-logs via NN.4 auditLogService
 *   - Returns precise per-row errors so the client can highlight
 *     the offending rows on partial failure
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { auditLogService } from '../services/audit-log.service.js'
import { idempotencyService } from '../services/idempotency.service.js'

interface ChannelCoverageRow {
  productId: string
  channel: string
  marketplace: string
  status: string
}

async function fetchChannelCoverage(
  productIds: string[],
): Promise<Map<string, ChannelCoverageRow[]>> {
  if (productIds.length === 0) return new Map()
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: productIds } },
    select: {
      productId: true,
      channel: true,
      marketplace: true,
      listingStatus: true,
    },
  })
  const map = new Map<string, ChannelCoverageRow[]>()
  for (const l of listings) {
    const arr = map.get(l.productId) ?? []
    arr.push({
      productId: l.productId,
      channel: l.channel,
      marketplace: l.marketplace,
      status: l.listingStatus,
    })
    map.set(l.productId, arr)
  }
  return map
}

const pimRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /pim/standalones ─────────────────────────────────────────
  // Returns products that are NOT parents and NOT children
  // (parentId === null). Optional search + pagination + filter on
  // channel coverage.
  fastify.get<{
    Querystring: {
      search?: string
      coverage?: 'all' | 'unlisted' | 'partial' | 'complete'
      limit?: string
      offset?: string
    }
  }>('/pim/standalones', async (request, reply) => {
    const search = request.query.search?.trim() ?? ''
    const coverage = request.query.coverage ?? 'all'
    const limit = Math.min(200, Number(request.query.limit ?? 50) || 50)
    const offset = Math.max(0, Number(request.query.offset ?? 0) || 0)
    try {
      const where: any = {
        isParent: false,
        parentId: null,
      }
      if (search) {
        where.OR = [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { brand: { contains: search, mode: 'insensitive' } },
        ]
      }
      const [total, products] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }],
          take: limit,
          skip: offset,
          select: {
            id: true,
            sku: true,
            name: true,
            brand: true,
            productType: true,
            basePrice: true,
            totalStock: true,
            updatedAt: true,
            amazonAsin: true,
            ebayItemId: true,
          },
        }),
      ])
      const coverageMap = await fetchChannelCoverage(
        products.map((p) => p.id),
      )
      // Compute coverage label per product. Active enabled-channel
      // count comes from how many distinct channels have ANY listing.
      const enriched = products.map((p) => {
        const rows = coverageMap.get(p.id) ?? []
        const distinct = new Set(rows.map((r) => `${r.channel}:${r.marketplace}`))
        const liveCount = rows.filter((r) => r.status === 'LIVE').length
        const draftCount = rows.filter((r) => r.status === 'DRAFT').length
        const failedCount = rows.filter((r) => r.status === 'FAILED').length
        const status =
          distinct.size === 0
            ? 'unlisted'
            : liveCount === distinct.size
            ? 'complete'
            : 'partial'
        return {
          ...p,
          basePrice: Number(p.basePrice ?? 0),
          channelCoverage: {
            status,
            slots: Array.from(distinct),
            liveCount,
            draftCount,
            failedCount,
          },
        }
      })
      // Apply coverage filter client-side AFTER enrichment so the
      // expensive count remains accurate to the broader query.
      const filtered =
        coverage === 'all'
          ? enriched
          : enriched.filter((p) => p.channelCoverage.status === coverage)
      return {
        items: filtered,
        total,
        limit,
        offset,
      }
    } catch (err) {
      fastify.log.error({ err }, '[pim/standalones] failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── GET /pim/parents-overview ────────────────────────────────────
  // Paginated parents with child counts + channel coverage so the
  // 'Parents' tab can render a catalog overview.
  fastify.get<{
    Querystring: {
      search?: string
      incomplete?: '1' | '0'
      limit?: string
      offset?: string
    }
  }>('/pim/parents-overview', async (request, reply) => {
    const search = request.query.search?.trim() ?? ''
    const limit = Math.min(200, Number(request.query.limit ?? 50) || 50)
    const offset = Math.max(0, Number(request.query.offset ?? 0) || 0)
    try {
      const where: any = { isParent: true }
      if (search) {
        where.OR = [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { brand: { contains: search, mode: 'insensitive' } },
        ]
      }
      const [total, parents] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }],
          take: limit,
          skip: offset,
          select: {
            id: true,
            sku: true,
            name: true,
            brand: true,
            productType: true,
            variationTheme: true,
            variationAxes: true,
            updatedAt: true,
          },
        }),
      ])
      // Per-parent: child count + total/live/draft/failed listing
      // counts across all children + the parent itself.
      const parentIds = parents.map((p) => p.id)
      const childAgg = await prisma.product.groupBy({
        by: ['parentId'],
        where: { parentId: { in: parentIds } },
        _count: { _all: true },
      })
      const childCount = new Map<string, number>()
      for (const r of childAgg) {
        if (r.parentId) childCount.set(r.parentId, r._count._all)
      }
      // Listings: pull all rows for parents + their kids in one
      // query, then bucket per parent.
      const allChildren = await prisma.product.findMany({
        where: { parentId: { in: parentIds } },
        select: { id: true, parentId: true },
      })
      const childToParent = new Map<string, string>()
      for (const c of allChildren) {
        if (c.parentId) childToParent.set(c.id, c.parentId)
      }
      const listings = await prisma.channelListing.findMany({
        where: {
          productId: {
            in: [...parentIds, ...allChildren.map((c) => c.id)],
          },
        },
        select: {
          productId: true,
          channel: true,
          marketplace: true,
          listingStatus: true,
        },
      })
      const perParent = new Map<
        string,
        { live: number; draft: number; failed: number; channels: Set<string> }
      >()
      for (const l of listings) {
        const key =
          parentIds.includes(l.productId)
            ? l.productId
            : childToParent.get(l.productId)
        if (!key) continue
        const slot =
          perParent.get(key) ??
          { live: 0, draft: 0, failed: 0, channels: new Set<string>() }
        slot.channels.add(`${l.channel}:${l.marketplace}`)
        if (l.listingStatus === 'LIVE') slot.live++
        else if (l.listingStatus === 'DRAFT') slot.draft++
        else if (l.listingStatus === 'FAILED') slot.failed++
        perParent.set(key, slot)
      }
      const enriched = parents.map((p) => {
        const slot = perParent.get(p.id) ?? {
          live: 0,
          draft: 0,
          failed: 0,
          channels: new Set<string>(),
        }
        return {
          ...p,
          childCount: childCount.get(p.id) ?? 0,
          listings: {
            live: slot.live,
            draft: slot.draft,
            failed: slot.failed,
            channels: Array.from(slot.channels),
          },
        }
      })
      const filtered =
        request.query.incomplete === '1'
          ? enriched.filter((p) => p.listings.draft + p.listings.failed > 0)
          : enriched
      return { items: filtered, total, limit, offset }
    } catch (err) {
      fastify.log.error({ err }, '[pim/parents-overview] failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── POST /pim/attach-to-parent ───────────────────────────────────
  // Link N standalone products under one parent. Each product in
  // axisValues[productId] gets variantAttributes + categoryAttributes.
  // variations set so the WW + XX read paths surface the values.
  fastify.post<{
    Body: {
      parentId: string
      productIds: string[]
      axisValues?: Record<string, Record<string, string>>
    }
  }>('/pim/attach-to-parent', async (request, reply) => {
    const { parentId, productIds, axisValues } = request.body ?? ({} as any)
    const idempotencyKey = request.headers['idempotency-key'] as
      | string
      | undefined
    const cached = idempotencyService.lookup('pim-attach', idempotencyKey)
    if (cached) return cached

    if (!parentId || !Array.isArray(productIds) || productIds.length === 0) {
      return reply
        .code(400)
        .send({ error: 'parentId + productIds[] required' })
    }
    if (productIds.length > 200) {
      return reply.code(400).send({ error: 'Max 200 productIds per request' })
    }
    if (productIds.includes(parentId)) {
      return reply
        .code(400)
        .send({ error: 'A product cannot be attached to itself' })
    }
    try {
      const parent = await prisma.product.findUnique({
        where: { id: parentId },
        select: { id: true, sku: true, isParent: true, parentId: true },
      })
      if (!parent) {
        return reply.code(404).send({ error: 'Parent not found' })
      }
      if (parent.parentId) {
        return reply.code(400).send({
          error: `Parent "${parent.sku}" is itself a child — pick a top-level parent.`,
        })
      }
      const targets = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, parentId: true, isParent: true },
      })
      const targetSet = new Set(targets.map((t) => t.id))
      const errors: Array<{ productId: string; error: string }> = []
      let attached = 0
      // Apply each child in its own transaction so a partial
      // failure doesn't roll back the whole batch. The first
      // findUnique is cheap.
      for (const productId of productIds) {
        if (!targetSet.has(productId)) {
          errors.push({ productId, error: 'product not found' })
          continue
        }
        const t = targets.find((x) => x.id === productId)!
        if (t.isParent) {
          errors.push({
            productId,
            error: `${t.sku} is already a parent — promote/demote first`,
          })
          continue
        }
        const incomingAxes = axisValues?.[productId] ?? {}
        const cleaned: Record<string, string> = {}
        for (const [k, v] of Object.entries(incomingAxes)) {
          const key = String(k).trim()
          const val = String(v ?? '').trim()
          if (key && val) cleaned[key] = val
        }
        try {
          await prisma.$transaction(async (tx) => {
            const beforeRow = await tx.product.findUnique({
              where: { id: productId },
              select: {
                parentId: true,
                variantAttributes: true,
                categoryAttributes: true,
              },
            })
            const currentCA =
              ((beforeRow?.categoryAttributes ?? {}) as {
                variations?: Record<string, string>
              }) ?? {}
            const nextCA = {
              ...currentCA,
              variations: { ...(currentCA.variations ?? {}), ...cleaned },
            }
            await tx.product.update({
              where: { id: productId },
              data: {
                parentId,
                isParent: false,
                ...(Object.keys(cleaned).length > 0
                  ? {
                      variantAttributes: cleaned as any,
                      categoryAttributes: nextCA as any,
                    }
                  : {}),
              },
            })
            // Make sure the parent's flag is set; harmless no-op
            // when already isParent=true.
            if (!parent.isParent) {
              await tx.product.update({
                where: { id: parentId },
                data: { isParent: true },
              })
            }
          })
          attached++
          void auditLogService.write({
            userId: null,
            ip: request.ip ?? null,
            entityType: 'Product',
            entityId: productId,
            action: 'attach-to-parent',
            after: { parentId, axisValues: cleaned },
            metadata: { source: 'pim-review' },
          })
        } catch (err) {
          errors.push({
            productId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const responseBody = { success: true, attached, errors, parentId }
      idempotencyService.store('pim-attach', idempotencyKey, responseBody)
      return responseBody
    } catch (err) {
      fastify.log.error({ err }, '[pim/attach-to-parent] failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── POST /pim/promote-to-parent ──────────────────────────────────
  // Flip isParent=true on a single product. Optional variation
  // theme + axes (so the WW Variations tab renders columns
  // immediately).
  fastify.post<{
    Body: {
      productId: string
      variationTheme?: string
      variationAxes?: string[]
    }
  }>('/pim/promote-to-parent', async (request, reply) => {
    const { productId, variationTheme, variationAxes } = request.body ?? ({} as any)
    const idempotencyKey = request.headers['idempotency-key'] as
      | string
      | undefined
    const cached = idempotencyService.lookup('pim-promote', idempotencyKey)
    if (cached) return cached

    if (!productId) {
      return reply.code(400).send({ error: 'productId required' })
    }
    try {
      const before = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, sku: true, isParent: true, parentId: true },
      })
      if (!before) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      if (before.parentId) {
        return reply.code(400).send({
          error: `${before.sku} is currently a child — detach it first`,
        })
      }
      await prisma.product.update({
        where: { id: productId },
        data: {
          isParent: true,
          ...(variationTheme ? { variationTheme } : {}),
          ...(Array.isArray(variationAxes)
            ? { variationAxes: variationAxes as any }
            : {}),
        },
      })
      void auditLogService.write({
        userId: null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: productId,
        action: 'promote-to-parent',
        after: { variationTheme, variationAxes },
        metadata: { source: 'pim-review' },
      })
      const responseBody = { success: true, productId }
      idempotencyService.store('pim-promote', idempotencyKey, responseBody)
      return responseBody
    } catch (err) {
      fastify.log.error({ err }, '[pim/promote-to-parent] failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

export default pimRoutes
