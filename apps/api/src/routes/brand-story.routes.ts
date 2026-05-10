/**
 * MC.9.1 — Amazon Brand Story (Brand Registry) CRUD.
 *
 * Mirrors aplus-content.routes.ts but for the brand-level surface.
 * Module CRUD + reorder + localize + apply-template + validate +
 * submit + versions + schedule land in MC.9.2 — MC.9.4. This commit
 * ships the schema, list, and detail endpoints.
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

const brandStoryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/brand-stories', async (request) => {
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
    const rows = await prisma.brandStory.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: {
        _count: {
          select: { modules: true, localizations: true },
        },
      },
    })
    return { items: rows }
  })

  fastify.get('/brand-stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const story = await prisma.brandStory.findUnique({
      where: { id },
      include: {
        modules: { orderBy: { position: 'asc' } },
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
    if (!story)
      return reply.code(404).send({ error: 'Brand Story not found' })
    return { story }
  })

  fastify.post('/brand-stories', async (request, reply) => {
    const body = request.body as {
      name?: string
      brand?: string
      marketplace?: string
      locale?: string
      masterStoryId?: string | null
    }
    if (!body.name?.trim())
      return reply.code(400).send({ error: 'name is required' })
    if (!body.brand?.trim())
      return reply.code(400).send({ error: 'brand is required' })
    if (!body.marketplace?.trim())
      return reply.code(400).send({ error: 'marketplace is required' })
    if (!body.locale?.trim())
      return reply.code(400).send({ error: 'locale is required' })

    if (body.masterStoryId) {
      const master = await prisma.brandStory.findUnique({
        where: { id: body.masterStoryId },
        select: { id: true },
      })
      if (!master)
        return reply
          .code(400)
          .send({ error: 'masterStoryId does not exist' })
    }

    try {
      const story = await prisma.brandStory.create({
        data: {
          name: body.name.trim(),
          brand: body.brand.trim(),
          marketplace: body.marketplace.trim(),
          locale: body.locale.trim(),
          masterStoryId: body.masterStoryId ?? null,
          status: 'DRAFT',
        },
        include: { modules: true },
      })
      return reply.code(201).send({ story })
    } catch (err: any) {
      // Unique constraint on (brand, marketplace, locale) — Amazon
      // rejects two stories competing for the same audience, so we
      // do too. Surface as 409 with the existing row's id so the UI
      // can offer to open it instead.
      if (err?.code === 'P2002') {
        const existing = await prisma.brandStory.findUnique({
          where: {
            brand_marketplace_locale: {
              brand: body.brand.trim(),
              marketplace: body.marketplace.trim(),
              locale: body.locale.trim(),
            },
          },
          select: { id: true },
        })
        return reply.code(409).send({
          error:
            'A Brand Story for this brand + marketplace + locale already exists',
          existingId: existing?.id ?? null,
        })
      }
      throw err
    }
  })

  fastify.patch('/brand-stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      name?: string
      status?: string
      notes?: string | null
    }
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) {
      if (!body.name.trim())
        return reply.code(400).send({ error: 'name cannot be empty' })
      data.name = body.name.trim()
    }
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
      const story = await prisma.brandStory.update({
        where: { id },
        data,
      })
      return { story }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'Brand Story not found' })
      throw err
    }
  })

  fastify.delete('/brand-stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.brandStory.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'Brand Story not found' })
      throw err
    }
  })
}

export default brandStoryRoutes
