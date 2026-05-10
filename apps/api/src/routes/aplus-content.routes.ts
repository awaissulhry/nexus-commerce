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
import { validateAplusDocument } from '../services/aplus-validation.service.js'
import {
  submitAplusDocument,
  submissionMode,
} from '../services/aplus-amazon.service.js'

// MC.8.10 — snapshot helper. Captures the full document + module
// state into APlusContentVersion. Returns the new version number
// so callers can surface "saved as v3".
async function snapshotAplusContent(
  contentId: string,
  reason: 'pre_submit' | 'manual_save' | 'pre_rollback',
  prismaClient: typeof prisma,
): Promise<number> {
  const content = await prismaClient.aPlusContent.findUnique({
    where: { id: contentId },
    include: { modules: { orderBy: { position: 'asc' } } },
  })
  if (!content) throw new Error(`content ${contentId} not found`)
  const lastVersion = await prismaClient.aPlusContentVersion.findFirst({
    where: { contentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const nextVersion = (lastVersion?.version ?? 0) + 1
  const snapshot = {
    name: content.name,
    brand: content.brand,
    marketplace: content.marketplace,
    locale: content.locale,
    status: content.status,
    notes: content.notes,
    modules: content.modules.map((m) => ({
      type: m.type,
      position: m.position,
      payload: m.payload,
    })),
  }
  await prismaClient.aPlusContentVersion.create({
    data: {
      contentId,
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

  // ── MC.8.9 — Submit to Amazon (sandbox by default) ───────

  fastify.post(
    '/aplus-content/:id/submit',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const content = await prisma.aPlusContent.findUnique({
        where: { id },
        include: { modules: { orderBy: { position: 'asc' } } },
      })
      if (!content)
        return reply.code(404).send({ error: 'A+ content not found' })

      const validation = validateAplusDocument({
        name: content.name,
        brand: content.brand,
        marketplace: content.marketplace,
        locale: content.locale,
        modules: content.modules.map((m) => ({
          type: m.type,
          payload: (m.payload as Record<string, unknown>) ?? {},
        })),
      })

      // MC.8.10 — snapshot before sending to Amazon. Even if the
      // submission fails, we have a record of "what we tried to
      // send" — useful for diffing against next attempt.
      try {
        await snapshotAplusContent(id, 'pre_submit', prisma)
      } catch (snapshotErr) {
        // Snapshot failure shouldn't block submission; log + carry
        // on. Operator notices via the missing version row.
        request.log.error(
          { err: snapshotErr, contentId: id },
          'Failed to snapshot pre_submit',
        )
      }

      const submission = await submitAplusDocument(
        {
          id: content.id,
          name: content.name,
          brand: content.brand,
          marketplace: content.marketplace,
          locale: content.locale,
          modules: content.modules.map((m) => ({
            type: m.type,
            payload: (m.payload as Record<string, unknown>) ?? {},
          })),
        },
        validation,
      )

      // Persist the submission outcome regardless of success — even
      // a failed submission is useful audit data ("we tried,
      // Amazon rejected because X"). amazonDocumentId stays
      // populated forever once set, so a retry overwrites with the
      // newest id.
      await prisma.aPlusContent.update({
        where: { id },
        data: {
          status: submission.ok ? 'SUBMITTED' : content.status,
          amazonDocumentId:
            submission.amazonDocumentId ?? content.amazonDocumentId,
          submittedAt: new Date(),
          submissionPayload: (submission.rawResponse as never) ?? null,
          notes: submission.error
            ? `${content.notes ? `${content.notes}\n\n` : ''}[${new Date().toISOString()}] Submission ${submission.mode}: ${submission.error}`
            : content.notes,
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

  fastify.get('/aplus-content/_meta/submission-mode', async () => {
    return { mode: submissionMode() }
  })

  // ── MC.8.10 — Versioning + scheduling ────────────────────

  fastify.get('/aplus-content/:id/versions', async (request) => {
    const { id } = request.params as { id: string }
    const versions = await prisma.aPlusContentVersion.findMany({
      where: { contentId: id },
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
    '/aplus-content/:id/versions/save',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const content = await prisma.aPlusContent.findUnique({
        where: { id },
        select: { id: true },
      })
      if (!content)
        return reply.code(404).send({ error: 'A+ content not found' })
      const version = await snapshotAplusContent(id, 'manual_save', prisma)
      return reply.code(201).send({ version })
    },
  )

  fastify.post(
    '/aplus-content/:id/versions/:versionId/restore',
    async (request, reply) => {
      const { id, versionId } = request.params as {
        id: string
        versionId: string
      }
      const target = await prisma.aPlusContentVersion.findUnique({
        where: { id: versionId },
      })
      if (!target || target.contentId !== id)
        return reply
          .code(404)
          .send({ error: 'version not found for this content' })

      // Snapshot current state first so the rollback is itself
      // undoable.
      await snapshotAplusContent(id, 'pre_rollback', prisma)

      interface SnapshotShape {
        name?: string
        brand?: string | null
        notes?: string | null
        status?: string
        modules?: Array<{
          type: string
          position: number
          payload: unknown
        }>
      }
      const snap = (target.snapshot ?? {}) as SnapshotShape

      await prisma.$transaction(async (tx) => {
        await tx.aPlusContent.update({
          where: { id },
          data: {
            // Roll back the editable surface only; status, marketplace
            // and locale stay where they are because rolling those
            // back can desync the row from Amazon's record.
            name: snap.name ?? undefined,
            brand: snap.brand ?? null,
            notes: snap.notes ?? null,
          },
        })
        await tx.aPlusModule.deleteMany({ where: { contentId: id } })
        if (Array.isArray(snap.modules) && snap.modules.length > 0) {
          await tx.aPlusModule.createMany({
            data: snap.modules.map((m, idx) => ({
              contentId: id,
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

  // Set/clear scheduledFor. Body: { scheduledFor: ISO string | null }.
  // The cron picker (a future commit) walks (status='APPROVED',
  // scheduledFor < now) and submits — we already have the
  // (status, scheduledFor) compound index for that scan.
  fastify.patch(
    '/aplus-content/:id/schedule',
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
        const content = await prisma.aPlusContent.update({
          where: { id },
          data: { scheduledFor: scheduled },
        })
        return { content }
      } catch (err: any) {
        if (err?.code === 'P2025')
          return reply.code(404).send({ error: 'A+ content not found' })
        throw err
      }
    },
  )

  // ── MC.8.8 — Server-side validation pre-flight ───────────

  fastify.post(
    '/aplus-content/:id/validate',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const content = await prisma.aPlusContent.findUnique({
        where: { id },
        include: { modules: { orderBy: { position: 'asc' } } },
      })
      if (!content)
        return reply.code(404).send({ error: 'A+ content not found' })

      const result = validateAplusDocument({
        name: content.name,
        brand: content.brand,
        marketplace: content.marketplace,
        locale: content.locale,
        modules: content.modules.map((m) => ({
          type: m.type,
          payload: (m.payload as Record<string, unknown>) ?? {},
        })),
      })
      return { result }
    },
  )

  // ── MC.8.7 — Apply template (bulk-create modules) ────────

  // POST /aplus-content/:id/apply-template
  //   body: { modules: [{ type, payload }, ...], replaceExisting?: bool }
  //
  // Server-side bulk insert so applying a 5-module template doesn't
  // need 5 round-trips. The client posts the resolved template
  // payload (templates live client-side in MC.8.7 — operator-
  // editable templates are MC.8.7-followup with a SavedAPlusTemplate
  // model). When `replaceExisting=true` we drop existing modules
  // first, otherwise we append to the current sequence.
  fastify.post(
    '/aplus-content/:id/apply-template',
    async (request, reply) => {
      const { id: contentId } = request.params as { id: string }
      const body = request.body as {
        modules?: Array<{ type?: string; payload?: unknown }>
        replaceExisting?: boolean
      }
      if (!Array.isArray(body.modules) || body.modules.length === 0)
        return reply.code(400).send({ error: 'modules array is required' })
      if (body.modules.some((m) => !m.type?.trim()))
        return reply
          .code(400)
          .send({ error: 'every module must have a non-empty type' })

      const content = await prisma.aPlusContent.findUnique({
        where: { id: contentId },
        select: { id: true },
      })
      if (!content)
        return reply.code(404).send({ error: 'A+ content not found' })

      const result = await prisma.$transaction(async (tx) => {
        let basePosition = 0
        if (body.replaceExisting) {
          await tx.aPlusModule.deleteMany({ where: { contentId } })
        } else {
          basePosition = await tx.aPlusModule.count({ where: { contentId } })
        }
        await tx.aPlusModule.createMany({
          data: body.modules!.map((m, idx) => ({
            contentId,
            type: m.type!,
            position: basePosition + idx,
            payload: (m.payload as never) ?? {},
          })),
        })
        return tx.aPlusModule.findMany({
          where: { contentId },
          orderBy: { position: 'asc' },
        })
      })
      return reply.code(201).send({
        modules: result,
        added: body.modules.length,
        replaced: !!body.replaceExisting,
      })
    },
  )

  // ── MC.8.6 — Localization sibling cloning ────────────────

  // POST /aplus-content/:id/localize — clone the master document
  // (and every module) into a new sibling row at a different
  // marketplace + locale. The new row's masterContentId points
  // back to the source so the localizations relation surfaces it
  // alongside the master.
  fastify.post(
    '/aplus-content/:id/localize',
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

      const source = await prisma.aPlusContent.findUnique({
        where: { id: sourceId },
        include: { modules: { orderBy: { position: 'asc' } } },
      })
      if (!source)
        return reply
          .code(404)
          .send({ error: 'source A+ content not found' })
      if (source.masterContentId)
        return reply.code(400).send({
          error:
            'localizations can only branch from a master row, not from a sibling',
        })

      // If a sibling for this marketplace+locale already exists,
      // return it instead of creating a duplicate. Operator likely
      // clicked twice; idempotency is friendlier than a 409.
      const existing = await prisma.aPlusContent.findFirst({
        where: {
          masterContentId: sourceId,
          marketplace: body.marketplace,
          locale: body.locale,
        },
      })
      if (existing)
        return reply
          .code(200)
          .send({ content: existing, alreadyExisted: true })

      const cloned = await prisma.$transaction(async (tx) => {
        const created = await tx.aPlusContent.create({
          data: {
            name: `${source.name}${body.nameSuffix ? ` — ${body.nameSuffix}` : ` (${body.locale})`}`,
            brand: source.brand,
            marketplace: body.marketplace!,
            locale: body.locale!,
            masterContentId: source.id,
            status: 'DRAFT',
          },
        })
        if (source.modules.length > 0) {
          await tx.aPlusModule.createMany({
            data: source.modules.map((m) => ({
              contentId: created.id,
              type: m.type,
              position: m.position,
              // Deep-copy the JSON payload so future edits to the
              // master don't propagate to the sibling. Operator
              // explicitly drives translation via the per-module
              // editor (or the deferred AI-translate flow).
              payload: JSON.parse(JSON.stringify(m.payload)),
            })),
          })
        }
        return created
      })

      return reply.code(201).send({ content: cloned, alreadyExisted: false })
    },
  )

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
