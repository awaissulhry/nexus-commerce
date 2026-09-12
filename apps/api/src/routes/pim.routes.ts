import { productReadCacheService } from '../services/product-read-cache.service.js'
/**
 * Catalog organization endpoints — backs /catalog/organize (renamed
 * from /pim/review on 2026-05-06). API path stays under /api/pim/* to
 * avoid a coordinated frontend+backend rename; the user-facing URL is
 * what matters and the API path is implementation detail.
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
import { productRoleOf } from '@nexus/shared/master-sheet'
import prisma from '../db.js'
import { attachProduct, demoteProduct, promoteProduct, reparentProduct, relationshipParent, relationshipTransaction } from '../services/pim/product-relationship.service.js'
import { relationshipAliasConflicts } from '../services/pim/relationship-alias-guard.js'
import { auditLogService } from '../services/audit-log.service.js'
import { idempotencyService } from '../services/idempotency.service.js'
import { listEtag, matches } from '../utils/list-etag.js'

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
  fastify.get<{ Querystring: { kind?: string; search?: string; exclude?: string } }>('/pim/relationship-choices', async (request, reply) => {
    const { kind, search = '', exclude = '' } = request.query
    if (kind !== 'parent' && kind !== 'standalone') return reply.code(400).send({ error: 'Choose parent or standalone products.' })
    const rows = await prisma.product.findMany({
      where: { deletedAt: null, parentId: null, id: { notIn: exclude.split(',').filter(Boolean).slice(0, 3) }, AND: [
        kind === 'parent' ? { OR: [{ isParent: true }, { children: { some: {} } }] } : { isParent: false, children: { none: {} } },
        { OR: [{ sku: { contains: search.trim(), mode: 'insensitive' } }, { name: { contains: search.trim(), mode: 'insensitive' } }] },
      ] },
      select: { id: true, sku: true, name: true }, orderBy: [{ sku: 'asc' }, { id: 'asc' }], take: 51,
    })
    const choices = rows.slice(0, 50)
    const blocked = kind === 'standalone' ? await relationshipAliasConflicts(prisma, choices.map(choice => choice.id)) : new Set<string>()
    return { items: choices.map(choice => ({ ...choice, ...(blocked.has(choice.id) ? { unavailable: 'Resolve listing aliases before attaching this product.' } : {}) })), more: rows.length > 50 }
  })
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
      // Phase 10b — ETag short-circuit. /catalog/organize Standalones
      // tab refetches on search (250ms debounce) + manual refresh; ETag
      // turns repeat hits without product churn into 304s.
      const { etag, count: etagCount } = await listEtag(prisma, {
        model: 'product',
        where,
        filterContext: { search, coverage, limit, offset },
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }
      const [total, products] = await Promise.all([
        Promise.resolve(etagCount),
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
    const incomplete = request.query.incomplete === '1'
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
      // Phase 10b — ETag short-circuit. /catalog/organize Parents tab.
      const { etag, count: etagCount } = await listEtag(prisma, {
        model: 'product',
        where,
        filterContext: { search, incomplete, limit, offset },
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }
      const [total, parents] = await Promise.all([
        Promise.resolve(etagCount),
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

    if (typeof parentId !== 'string' || !parentId || !Array.isArray(productIds) || productIds.length === 0 || productIds.some(id => typeof id !== 'string' || !id)) {
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
      await relationshipTransaction(tx => relationshipParent(tx, parentId))
      const errors: Array<{ productId: string; error: string }> = []
      let attached = 0
      // Preserve the documented per-child result; each accepted child is atomic.
      for (const productId of [...new Set<string>(productIds)]) {
        const cleaned: Record<string, string> = {}
        for (const [k, v] of Object.entries(axisValues?.[productId] ?? {})) {
          const key = k.trim(), value = String(v ?? '').trim()
          if (key && value) cleaned[key] = value
        }
        try {
          const changed = await relationshipTransaction(tx => attachProduct(tx, parentId, productId, cleaned))
          attached++
          if (changed) void auditLogService.write({
            userId: null, ip: request.ip ?? null, entityType: 'Product', entityId: productId,
            action: 'attach-to-parent', after: { parentId, axisValues: cleaned }, metadata: { source: 'pim-review' },
          })
        } catch (err) {
          errors.push({ productId, error: err instanceof Error ? err.message : String(err) })
        }
      }
      const responseBody = { success: true, attached, errors, parentId }
      idempotencyService.store('pim-attach', idempotencyKey, responseBody)
      return responseBody
    } catch (err) {
      fastify.log.error({ err }, '[pim/attach-to-parent] failed')
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
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
      await relationshipTransaction(tx => promoteProduct(tx, productId, variationTheme, Array.isArray(variationAxes) ? variationAxes : undefined))
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
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── GET /pim/parent/:id/children ─────────────────────────────────
  // C.4 — child-list preview drawer on the Parents tab. Returns the
  // Product rows whose parentId matches, with the columns needed to
  // render the inline children panel without navigating away. Cached
  // briefly (no ETag yet — small payload, sub-second query).
  fastify.get<{ Params: { id: string } }>(
    '/pim/parent/:id/children',
    async (request, reply) => {
      try {
        const parent = await prisma.product.findUnique({
          where: { id: request.params.id },
          select: { id: true, isParent: true, sku: true, name: true },
        })
        if (!parent) {
          return reply.code(404).send({ error: 'Parent not found' })
        }
        const children = await prisma.product.findMany({
          where: { parentId: parent.id },
          orderBy: { sku: 'asc' },
          select: {
            id: true,
            sku: true,
            name: true,
            variantAttributes: true,
            amazonAsin: true,
            ebayItemId: true,
          },
        })
        return {
          success: true,
          parent: { id: parent.id, sku: parent.sku, name: parent.name },
          children,
        }
      } catch (err) {
        fastify.log.error(
          { err },
          '[pim/parent/:id/children] failed',
        )
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // ── POST /pim/bulk-promote-to-parent ─────────────────────────────
  // C.4 — multi-select promote. Each id is promoted independently;
  // ids that are currently children (parentId set) are skipped with
  // a per-id reason in the response. Variation theme + axes apply
  // uniformly to every promoted product so the typical use case
  // ("promote 12 standalones into shared 'Color/Size' parents") is
  // a single request. Capped at 100.
  fastify.post<{
    Body: {
      productIds: string[]
      variationTheme?: string
      variationAxes?: string[]
    }
  }>('/pim/bulk-promote-to-parent', async (request, reply) => {
    const body = request.body ?? ({} as any)
    const ids = Array.isArray(body.productIds)
      ? body.productIds.filter(
          (id: unknown): id is string =>
            typeof id === 'string' && id.length > 0,
        )
      : []
    if (ids.length === 0) {
      return reply.code(400).send({ error: 'productIds required' })
    }
    if (ids.length > 100) {
      return reply
        .code(400)
        .send({ error: 'Bulk promote capped at 100 entries.' })
    }
    try {
      const { promoted, candidates, childIds, missingIds } = await relationshipTransaction(async tx => {
        const candidates = await tx.product.findMany({
          where: { id: { in: ids }, deletedAt: null },
          select: { id: true, sku: true, parentId: true, isParent: true },
        })
        const present = new Set(candidates.map(candidate => candidate.id))
        const missingIds = ids.filter(id => !present.has(id))
        const childIds = candidates.filter(candidate => candidate.parentId).map(candidate => candidate.id)
        const eligibleIds = candidates.filter(candidate => !candidate.parentId && !candidate.isParent).map(candidate => candidate.id)
        const result = eligibleIds.length ? await tx.product.updateMany({
          where: { id: { in: eligibleIds }, parentId: null, isParent: false, deletedAt: null },
          data: {
            isParent: true, version: { increment: 1 },
            ...(typeof body.variationTheme === 'string' && body.variationTheme ? { variationTheme: body.variationTheme } : {}),
            ...(Array.isArray(body.variationAxes) ? { variationAxes: body.variationAxes as any } : {}),
          },
        }) : { count: 0 }
        await productReadCacheService.refreshInTransaction(tx, eligibleIds)
        return { promoted: result.count, candidates, childIds, missingIds }
      })
      for (const id of candidates.filter(candidate => !candidate.parentId && !candidate.isParent).map(candidate => candidate.id)) {
        void auditLogService.write({
          userId: null, ip: request.ip ?? null, entityType: 'Product', entityId: id,
          action: 'promote-to-parent', after: { variationTheme: body.variationTheme, variationAxes: body.variationAxes },
          metadata: { source: 'pim-review-bulk' },
        })
      }

      return {
        success: true,
        promoted,
        skipped: {
          alreadyParent: candidates.filter((c) => c.isParent).map((c) => c.id),
          currentlyChild: childIds,
          notFound: missingIds,
        },
      }
    } catch (err) {
      fastify.log.error({ err }, '[pim/bulk-promote-to-parent] failed')
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── GET /pim/family/:productId ────────────────────────────────────
  // Returns the full family picture for a product: its role, its
  // parent (if a child), its children (if a parent), and siblings
  // (if a child). Used by the Matrix tab FamilySection for all three
  // role-aware views.
  fastify.get<{ Params: { productId: string } }>(
    '/pim/family/:productId',
    async (request, reply) => {
      try {
        const { productId } = request.params
        const self = await prisma.product.findUnique({
          where: { id: productId, deletedAt: null },
          select: {
            id: true, sku: true, name: true, isParent: true, parentId: true,
            variationTheme: true, variationAxes: true,
            _count: { select: { children: { where: { deletedAt: null } } } },
          },
        })
        if (!self) return reply.code(404).send({ error: 'Product not found' })

        const role = productRoleOf({ ...self, childCount: self._count.children })

        let parent: any = null
        let children: any[] = []
        let siblings: any[] = []

        if (role === 'child' && self.parentId) {
          const [p, sibs] = await Promise.all([
            prisma.product.findUnique({
              where: { id: self.parentId },
              select: { id: true, sku: true, name: true, variationTheme: true, variationAxes: true },
            }),
            prisma.product.findMany({
              where: { parentId: self.parentId, deletedAt: null, id: { not: productId } },
              orderBy: { sku: 'asc' },
              select: { id: true, sku: true, name: true, variantAttributes: true },
            }),
          ])
          parent = p
          siblings = sibs
        } else if (role === 'parent') {
          children = await prisma.product.findMany({
            where: { parentId: productId, deletedAt: null },
            orderBy: { sku: 'asc' },
            select: { id: true, sku: true, name: true, variantAttributes: true },
          })
        }

        return { role, self, parent, children, siblings }
      } catch (err) {
        fastify.log.error({ err }, '[pim/family] failed')
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // ── POST /pim/demote-parent ──────────────────────────────────────
  // Flip isParent=false on a parent product, clearing variationTheme.
  // Blocked if children exist unless force=true (which orphans them).
  fastify.post<{
    Body: { productId: string; force?: boolean; expectedChildIds?: string[] }
  }>('/pim/demote-parent', async (request, reply) => {
    const { productId, force, expectedChildIds } = request.body ?? ({} as any)
    if (!productId) return reply.code(400).send({ error: 'productId required' })
    try {
      await relationshipTransaction(tx => demoteProduct(tx, productId, force === true, expectedChildIds))
      void auditLogService.write({
        userId: null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: productId,
        action: 'demote-parent',
        after: { isParent: false, force: !!force },
        metadata: { source: 'matrix-tab' },
      })
      return { success: true, productId }
    } catch (err) {
      fastify.log.error({ err }, '[pim/demote-parent] failed')
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── POST /pim/reparent ───────────────────────────────────────────
  // Atomically move a child to a different parent. Cycle detection
  // (productId ≠ newParentId). An empty former parent retains its role
  // until the operator explicitly demotes it, matching unlink and imports.
  fastify.post<{
    Body: { productId: string; newParentId: string; expectedParentId?: string }
  }>('/pim/reparent', async (request, reply) => {
    const { productId, newParentId, expectedParentId } = request.body ?? ({} as any)
    if (!productId || !newParentId) {
      return reply.code(400).send({ error: 'productId + newParentId required' })
    }
    if (productId === newParentId) {
      return reply.code(400).send({ error: 'A product cannot be its own parent' })
    }
    try {
      const { oldParentId } = await relationshipTransaction(tx => reparentProduct(tx, productId, newParentId, expectedParentId))
      void auditLogService.write({
        userId: null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: productId,
        action: 'reparent',
        after: { newParentId, oldParentId },
        metadata: { source: 'matrix-tab' },
      })
      return { success: true, productId, newParentId, oldParentId }
    } catch (err) {
      fastify.log.error({ err }, '[pim/reparent] failed')
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

export default pimRoutes
