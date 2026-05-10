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
import { validateBrandStoryDocument } from '../services/brand-story-validation.service.js'
import {
  submitBrandStoryDocument,
  submissionMode,
} from '../services/brand-story-amazon.service.js'

// MC.9.4 — snapshot helper. Same shape as the A+ Content version
// snapshot in aplus-content.routes.ts.
async function snapshotBrandStory(
  storyId: string,
  reason: 'pre_submit' | 'manual_save' | 'pre_rollback',
  prismaClient: typeof prisma,
): Promise<number> {
  const story = await prismaClient.brandStory.findUnique({
    where: { id: storyId },
    include: { modules: { orderBy: { position: 'asc' } } },
  })
  if (!story) throw new Error(`Brand Story ${storyId} not found`)
  const lastVersion = await prismaClient.brandStoryVersion.findFirst({
    where: { storyId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const nextVersion = (lastVersion?.version ?? 0) + 1
  const snapshot = {
    name: story.name,
    brand: story.brand,
    marketplace: story.marketplace,
    locale: story.locale,
    status: story.status,
    notes: story.notes,
    modules: story.modules.map((m) => ({
      type: m.type,
      position: m.position,
      payload: m.payload,
    })),
  }
  await prismaClient.brandStoryVersion.create({
    data: {
      storyId,
      version: nextVersion,
      reason,
      snapshot: snapshot as never,
    },
  })
  return nextVersion
}

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

  // ── MC.9.2 — Module CRUD + reorder ───────────────────────

  fastify.post(
    '/brand-stories/:id/modules',
    async (request, reply) => {
      const { id: storyId } = request.params as { id: string }
      const body = request.body as { type?: string; payload?: unknown }
      if (!body.type?.trim())
        return reply.code(400).send({ error: 'type is required' })

      const story = await prisma.brandStory.findUnique({
        where: { id: storyId },
        select: { id: true },
      })
      if (!story)
        return reply.code(404).send({ error: 'Brand Story not found' })

      const existingCount = await prisma.brandStoryModule.count({
        where: { storyId },
      })

      const module = await prisma.brandStoryModule.create({
        data: {
          storyId,
          type: body.type,
          position: existingCount,
          payload: (body.payload as never) ?? {},
        },
      })
      return reply.code(201).send({ module })
    },
  )

  fastify.patch('/brand-story-modules/:id', async (request, reply) => {
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
      const module = await prisma.brandStoryModule.update({
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

  fastify.delete('/brand-story-modules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const deleted = await prisma.brandStoryModule.delete({
        where: { id },
        select: { storyId: true, position: true },
      })
      // Re-pack positions so the canvas stays 0..n-1 contiguous.
      await prisma.brandStoryModule.updateMany({
        where: {
          storyId: deleted.storyId,
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

  // ── MC.9.3 — Localization sibling cloning ───────────────

  fastify.post(
    '/brand-stories/:id/localize',
    async (request, reply) => {
      const { id: sourceId } = request.params as { id: string }
      const body = request.body as {
        marketplace?: string
        locale?: string
        nameSuffix?: string
      }
      if (!body.marketplace?.trim())
        return reply
          .code(400)
          .send({ error: 'marketplace is required' })
      if (!body.locale?.trim())
        return reply.code(400).send({ error: 'locale is required' })

      const source = await prisma.brandStory.findUnique({
        where: { id: sourceId },
        include: { modules: { orderBy: { position: 'asc' } } },
      })
      if (!source)
        return reply
          .code(404)
          .send({ error: 'source Brand Story not found' })
      if (source.masterStoryId)
        return reply.code(400).send({
          error:
            'localizations can only branch from a master row, not from a sibling',
        })

      // Idempotent — if a sibling for this brand+marketplace+locale
      // already exists, return it. Brand+marketplace+locale is the
      // unique key on BrandStory itself.
      const existing = await prisma.brandStory.findUnique({
        where: {
          brand_marketplace_locale: {
            brand: source.brand,
            marketplace: body.marketplace,
            locale: body.locale,
          },
        },
      })
      if (existing)
        return reply
          .code(200)
          .send({ story: existing, alreadyExisted: true })

      const cloned = await prisma.$transaction(async (tx) => {
        const created = await tx.brandStory.create({
          data: {
            name: `${source.name}${body.nameSuffix ? ` — ${body.nameSuffix}` : ` (${body.locale})`}`,
            brand: source.brand,
            marketplace: body.marketplace!,
            locale: body.locale!,
            masterStoryId: source.id,
            status: 'DRAFT',
          },
        })
        if (source.modules.length > 0) {
          await tx.brandStoryModule.createMany({
            data: source.modules.map((m) => ({
              storyId: created.id,
              type: m.type,
              position: m.position,
              payload: JSON.parse(JSON.stringify(m.payload)),
            })),
          })
        }
        return created
      })

      return reply.code(201).send({ story: cloned, alreadyExisted: false })
    },
  )

  fastify.post(
    '/brand-stories/:id/modules/reorder',
    async (request, reply) => {
      const { id: storyId } = request.params as { id: string }
      const body = request.body as {
        order?: Array<{ id: string; position: number }>
      }
      const order = body.order
      if (!Array.isArray(order) || order.length === 0)
        return reply.code(400).send({ error: 'order array is required' })

      const owned = await prisma.brandStoryModule.findMany({
        where: { storyId },
        select: { id: true },
      })
      const ownedSet = new Set(owned.map((r) => r.id))
      if (order.some((row) => !ownedSet.has(row.id)))
        return reply
          .code(400)
          .send({ error: 'order contains modules from another story' })

      await prisma.$transaction(
        order.map((row) =>
          prisma.brandStoryModule.update({
            where: { id: row.id },
            data: { position: row.position },
          }),
        ),
      )
      return { updated: order.length }
    },
  )
}

// ── MC.9.4 — Validation + submission + versions + schedule ─

const additionalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/brand-stories/:id/validate',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const story = await prisma.brandStory.findUnique({
        where: { id },
        include: { modules: { orderBy: { position: 'asc' } } },
      })
      if (!story)
        return reply.code(404).send({ error: 'Brand Story not found' })
      const result = validateBrandStoryDocument({
        name: story.name,
        brand: story.brand,
        marketplace: story.marketplace,
        locale: story.locale,
        modules: story.modules.map((m) => ({
          type: m.type,
          payload: (m.payload as Record<string, unknown>) ?? {},
        })),
      })
      return { result }
    },
  )

  fastify.post(
    '/brand-stories/:id/submit',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const story = await prisma.brandStory.findUnique({
        where: { id },
        include: { modules: { orderBy: { position: 'asc' } } },
      })
      if (!story)
        return reply.code(404).send({ error: 'Brand Story not found' })

      const validation = validateBrandStoryDocument({
        name: story.name,
        brand: story.brand,
        marketplace: story.marketplace,
        locale: story.locale,
        modules: story.modules.map((m) => ({
          type: m.type,
          payload: (m.payload as Record<string, unknown>) ?? {},
        })),
      })

      try {
        await snapshotBrandStory(id, 'pre_submit', prisma)
      } catch (snapshotErr) {
        request.log.error(
          { err: snapshotErr, storyId: id },
          'Failed to snapshot pre_submit',
        )
      }

      const submission = await submitBrandStoryDocument(
        {
          id: story.id,
          name: story.name,
          brand: story.brand,
          marketplace: story.marketplace,
          locale: story.locale,
          modules: story.modules.map((m) => ({
            type: m.type,
            payload: (m.payload as Record<string, unknown>) ?? {},
          })),
        },
        validation,
      )

      await prisma.brandStory.update({
        where: { id },
        data: {
          status: submission.ok ? 'SUBMITTED' : story.status,
          amazonDocumentId:
            submission.amazonDocumentId ?? story.amazonDocumentId,
          submittedAt: new Date(),
          submissionPayload: (submission.rawResponse as never) ?? null,
          notes: submission.error
            ? `${story.notes ? `${story.notes}\n\n` : ''}[${new Date().toISOString()}] Submission ${submission.mode}: ${submission.error}`
            : story.notes,
        },
      })

      return {
        ok: submission.ok,
        mode: submission.mode,
        amazonDocumentId: submission.amazonDocumentId,
        validation,
        error: submission.error,
      }
    },
  )

  fastify.get('/brand-stories/_meta/submission-mode', async () => {
    return { mode: submissionMode() }
  })

  fastify.get('/brand-stories/:id/versions', async (request) => {
    const { id } = request.params as { id: string }
    const versions = await prisma.brandStoryVersion.findMany({
      where: { storyId: id },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        reason: true,
        createdAt: true,
      },
    })
    return { versions }
  })

  fastify.post(
    '/brand-stories/:id/versions/save',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const story = await prisma.brandStory.findUnique({
        where: { id },
        select: { id: true },
      })
      if (!story)
        return reply.code(404).send({ error: 'Brand Story not found' })
      const version = await snapshotBrandStory(id, 'manual_save', prisma)
      return reply.code(201).send({ version })
    },
  )

  fastify.post(
    '/brand-stories/:id/versions/:versionId/restore',
    async (request, reply) => {
      const { id, versionId } = request.params as {
        id: string
        versionId: string
      }
      const target = await prisma.brandStoryVersion.findUnique({
        where: { id: versionId },
      })
      if (!target || target.storyId !== id)
        return reply
          .code(404)
          .send({ error: 'version not found for this story' })

      await snapshotBrandStory(id, 'pre_rollback', prisma)

      interface SnapshotShape {
        name?: string
        notes?: string | null
        modules?: Array<{
          type: string
          position: number
          payload: unknown
        }>
      }
      const snap = (target.snapshot ?? {}) as SnapshotShape

      await prisma.$transaction(async (tx) => {
        await tx.brandStory.update({
          where: { id },
          data: {
            name: snap.name ?? undefined,
            notes: snap.notes ?? null,
          },
        })
        await tx.brandStoryModule.deleteMany({ where: { storyId: id } })
        if (Array.isArray(snap.modules) && snap.modules.length > 0) {
          await tx.brandStoryModule.createMany({
            data: snap.modules.map((m, idx) => ({
              storyId: id,
              type: m.type,
              position: typeof m.position === 'number' ? m.position : idx,
              payload: (m.payload as never) ?? {},
            })),
          })
        }
      })
      return { ok: true, restoredVersion: target.version }
    },
  )

  fastify.patch(
    '/brand-stories/:id/schedule',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as { scheduledFor?: string | null }
      let scheduled: Date | null = null
      if (body.scheduledFor) {
        const parsed = new Date(body.scheduledFor)
        if (isNaN(parsed.getTime()))
          return reply
            .code(400)
            .send({ error: 'scheduledFor must be an ISO datetime' })
        if (parsed.getTime() < Date.now() - 60_000)
          return reply
            .code(400)
            .send({ error: 'scheduledFor must be in the future' })
        scheduled = parsed
      }
      try {
        const story = await prisma.brandStory.update({
          where: { id },
          data: { scheduledFor: scheduled },
        })
        return { story }
      } catch (err: any) {
        if (err?.code === 'P2025')
          return reply.code(404).send({ error: 'Brand Story not found' })
        throw err
      }
    },
  )
}

const composedRoutes: FastifyPluginAsync = async (fastify) => {
  await brandStoryRoutes(fastify, {})
  await additionalRoutes(fastify, {})
}

export default composedRoutes
