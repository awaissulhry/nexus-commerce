/**
 * MC.8.1 — Amazon A+ Content (Brand Registry) CRUD.
 *
 * Schema layer in this commit. The visual builder + module CRUD lands
 * in MC.8.3; the list page lands in MC.8.2 against this endpoint;
 * Amazon SP-API submission lands in MC.8.9 (sandbox-only by default
 * per the engagement directive).
 *
 * Endpoints (all under /api):
 *   GET    /aplus-content                    list (?marketplace, ?status, ?brand, ?search)
 *   GET    /aplus-content/:id                detail w/ modules + asins
 *   POST   /aplus-content                    create draft
 *   PATCH  /aplus-content/:id                update top-level fields
 *   DELETE /aplus-content/:id                cascade-drops modules + asin attachments
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const VALID_STATUSES = new Set([
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'SUBMITTED',
  'PUBLISHED',
  'REJECTED',
])

const aPlusContentRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List ──────────────────────────────────────────────────

  fastify.get('/aplus-content', async (request) => {
    const q = request.query as {
      marketplace?: string
      status?: string
      brand?: string
      search?: string
      limit?: string
    }
    const limit = Math.min(
      Math.max(parseInt(q.limit ?? '100', 10) || 100, 1),
      500,
    )
    const where: Record<string, unknown> = {}
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.status && VALID_STATUSES.has(q.status)) where.status = q.status
    if (q.brand) where.brand = q.brand
    if (q.search?.trim()) {
      const s = q.search.trim()
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { brand: { contains: s, mode: 'insensitive' } },
        { notes: { contains: s, mode: 'insensitive' } },
      ]
    }
    const rows = await prisma.aPlusContent.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: {
        _count: {
          select: { modules: true, asinAttachments: true, localizations: true },
        },
      },
    })
    return { items: rows }
  })

  // ── Detail ────────────────────────────────────────────────

  fastify.get('/aplus-content/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const content = await prisma.aPlusContent.findUnique({
      where: { id },
      include: {
        modules: { orderBy: { position: 'asc' } },
        asinAttachments: {
          include: {
            product: { select: { id: true, sku: true, name: true } },
          },
          orderBy: { attachedAt: 'asc' },
        },
        localizations: {
          select: {
            id: true,
            locale: true,
            marketplace: true,
            status: true,
            updatedAt: true,
          },
        },
        master: {
          select: {
            id: true,
            locale: true,
            marketplace: true,
            status: true,
          },
        },
      },
    })
    if (!content)
      return reply.code(404).send({ error: 'A+ content not found' })
    return { content }
  })

  // ── Create ────────────────────────────────────────────────

  fastify.post('/aplus-content', async (request, reply) => {
    const body = request.body as {
      name?: string
      brand?: string | null
      marketplace?: string
      locale?: string
      masterContentId?: string | null
      asins?: string[]
    }
    if (!body.name?.trim())
      return reply.code(400).send({ error: 'name is required' })
    if (!body.marketplace?.trim())
      return reply.code(400).send({ error: 'marketplace is required' })
    if (!body.locale?.trim())
      return reply.code(400).send({ error: 'locale is required' })

    if (body.masterContentId) {
      const master = await prisma.aPlusContent.findUnique({
        where: { id: body.masterContentId },
        select: { id: true },
      })
      if (!master)
        return reply
          .code(400)
          .send({ error: 'masterContentId does not exist' })
    }

    const content = await prisma.aPlusContent.create({
      data: {
        name: body.name.trim(),
        brand: body.brand?.trim() || null,
        marketplace: body.marketplace.trim(),
        locale: body.locale.trim(),
        masterContentId: body.masterContentId ?? null,
        status: 'DRAFT',
        // Operator can pre-attach ASINs at create time (common for
        // "I'm building this for these 5 products" workflows).
        asinAttachments: Array.isArray(body.asins) && body.asins.length
          ? {
              create: body.asins
                .map((a) => a.trim())
                .filter(Boolean)
                .map((asin) => ({ asin })),
            }
          : undefined,
      },
      include: {
        modules: true,
        asinAttachments: true,
      },
    })
    return reply.code(201).send({ content })
  })

  // ── Patch ─────────────────────────────────────────────────

  fastify.patch('/aplus-content/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      name?: string
      brand?: string | null
      status?: string
      notes?: string | null
    }
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) {
      if (!body.name.trim())
        return reply.code(400).send({ error: 'name cannot be empty' })
      data.name = body.name.trim()
    }
    if (body.brand !== undefined) data.brand = body.brand?.trim() || null
    if (body.status !== undefined) {
      if (!VALID_STATUSES.has(body.status))
        return reply.code(400).send({
          error: `status must be one of ${[...VALID_STATUSES].join(', ')}`,
        })
      data.status = body.status
    }
    if (body.notes !== undefined) data.notes = body.notes?.trim() || null
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const content = await prisma.aPlusContent.update({
        where: { id },
        data,
      })
      return { content }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'A+ content not found' })
      throw err
    }
  })

  // ── Delete ────────────────────────────────────────────────

  fastify.delete('/aplus-content/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.aPlusContent.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'A+ content not found' })
      throw err
    }
  })

  // ── MC.8.3 — Modules CRUD + reorder ───────────────────────

  // Create a module appended to the end. Position is computed
  // server-side so concurrent appends from two browser tabs don't
  // collide (last-write-wins on the count is fine — both rows end
  // up with consecutive positions).
  fastify.post('/aplus-content/:id/modules', async (request, reply) => {
    const { id: contentId } = request.params as { id: string }
    const body = request.body as { type?: string; payload?: unknown }
    if (!body.type?.trim())
      return reply.code(400).send({ error: 'type is required' })

    const content = await prisma.aPlusContent.findUnique({
      where: { id: contentId },
      select: { id: true },
    })
    if (!content)
      return reply.code(404).send({ error: 'A+ content not found' })

    const existingCount = await prisma.aPlusModule.count({
      where: { contentId },
    })

    const module = await prisma.aPlusModule.create({
      data: {
        contentId,
        type: body.type,
        position: existingCount,
        // Default to {} so every module row is queryable JSON; the
        // builder fills in the type-specific shape on first edit.
        payload: (body.payload as never) ?? {},
      },
    })
    return reply.code(201).send({ module })
  })

  fastify.patch('/aplus-modules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { type?: string; payload?: unknown }
    const data: Record<string, unknown> = {}
    if (body.type !== undefined) {
      if (!body.type.trim())
        return reply.code(400).send({ error: 'type cannot be empty' })
      data.type = body.type
    }
    if (body.payload !== undefined) {
      data.payload = (body.payload as never) ?? {}
    }
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const module = await prisma.aPlusModule.update({
        where: { id },
        data,
      })
      return { module }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'module not found' })
      throw err
    }
  })

  fastify.delete('/aplus-modules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      // Capture the deleted module's contentId + position so we can
      // re-pack the remaining siblings without leaving a hole. The
      // builder treats positions as 0..n-1 contiguous; gaps would
      // confuse drag-reorder math.
      const deleted = await prisma.aPlusModule.delete({
        where: { id },
        select: { contentId: true, position: true },
      })
      await prisma.aPlusModule.updateMany({
        where: {
          contentId: deleted.contentId,
          position: { gt: deleted.position },
        },
        data: { position: { decrement: 1 } },
      })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'module not found' })
      throw err
    }
  })

  // Bulk reorder. Body: { order: [{ id, position }] }. Caller sends
  // the complete new sequence (matches ProductImage reorder pattern
  // from W8.1). Server validates that every id belongs to the
  // referenced content row, then applies in a transaction so a
  // partial failure doesn't leave half-reordered rows.
  fastify.post(
    '/aplus-content/:id/modules/reorder',
    async (request, reply) => {
      const { id: contentId } = request.params as { id: string }
      const body = request.body as {
        order?: Array<{ id: string; position: number }>
      }
      const order = body.order
      if (!Array.isArray(order) || order.length === 0)
        return reply.code(400).send({ error: 'order array is required' })

      const owned = await prisma.aPlusModule.findMany({
        where: { contentId },
        select: { id: true },
      })
      const ownedSet = new Set(owned.map((r) => r.id))
      if (order.some((row) => !ownedSet.has(row.id)))
        return reply
          .code(400)
          .send({ error: 'order contains modules from another content row' })

      await prisma.$transaction(
        order.map((row) =>
          prisma.aPlusModule.update({
            where: { id: row.id },
            data: { position: row.position },
          }),
        ),
      )
      return { updated: order.length }
    },
  )
}

export default aPlusContentRoutes
