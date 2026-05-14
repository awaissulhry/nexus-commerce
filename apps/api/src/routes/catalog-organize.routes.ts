import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

/**
 * /api/catalog/organize — session-based publish + undo.
 *
 * POST /publish   — attach N products to parents, enqueue channel sync,
 *                   store CatalogOrganizeSession for 48-hour undo.
 * GET  /sessions  — recent sessions for the history panel (Phase 5).
 * POST /undo/:id  — restore pre-publish state + create reversal queue rows.
 */
const catalogOrganizeRoutes: FastifyPluginAsync = async (fastify) => {

  // ── POST /api/catalog/organize/publish ───────────────────────────
  fastify.post<{
    Body: {
      changes: Array<{
        productId: string
        toParentId: string
        attributes?: Record<string, string>
      }>
    }
  }>('/organize/publish', async (request, reply) => {
    const { changes } = request.body ?? {}
    if (!Array.isArray(changes) || changes.length === 0) {
      return reply.code(400).send({ error: 'changes[] required' })
    }
    if (changes.length > 100) {
      return reply.code(400).send({ error: 'Max 100 changes per publish' })
    }

    const undoExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)

    // Create session up front so change rows can reference it.
    const session = await prisma.catalogOrganizeSession.create({
      data: {
        status: 'PUBLISHED',
        undoExpiresAt,
      },
    })

    const errors: Array<{ productId: string; sku: string; error: string }> = []
    let published = 0

    for (const change of changes) {
      const { productId, toParentId, attributes = {} } = change

      // Clean attributes — strip blank values.
      const cleanedAttrs: Record<string, string> = {}
      for (const [k, v] of Object.entries(attributes)) {
        const key = String(k).trim()
        const val = String(v ?? '').trim()
        if (key && val) cleanedAttrs[key] = val
      }

      try {
        // Snapshot + validate in one query.
        const [product, parent] = await Promise.all([
          prisma.product.findUnique({
            where: { id: productId },
            select: {
              id: true,
              sku: true,
              parentId: true,
              isParent: true,
              variantAttributes: true,
              channelListings: {
                select: {
                  id: true,
                  channel: true,
                  marketplace: true,
                },
              },
            },
          }),
          prisma.product.findUnique({
            where: { id: toParentId },
            select: { id: true, sku: true, isParent: true, parentId: true },
          }),
        ])

        if (!product) {
          errors.push({ productId, sku: '?', error: 'Product not found' })
          continue
        }
        if (!parent) {
          errors.push({ productId, sku: product.sku, error: `Parent ${toParentId} not found` })
          continue
        }
        if (parent.parentId) {
          errors.push({
            productId,
            sku: product.sku,
            error: `Parent "${parent.sku}" is itself a child — pick a top-level parent`,
          })
          continue
        }
        if (product.isParent) {
          errors.push({
            productId,
            sku: product.sku,
            error: `${product.sku} is a parent product — demote it first`,
          })
          continue
        }

        // Apply the change + create queue rows in one transaction.
        const queueIds: string[] = []

        await prisma.$transaction(async (tx) => {
          // 1. Attach product to parent.
          await tx.product.update({
            where: { id: productId },
            data: {
              parentId: toParentId,
              isParent: false,
              ...(Object.keys(cleanedAttrs).length > 0
                ? {
                    variantAttributes: cleanedAttrs as any,
                    categoryAttributes: {
                      variations: cleanedAttrs,
                    } as any,
                  }
                : {}),
            },
          })

          // 2. Ensure parent flag is set.
          if (!parent.isParent) {
            await tx.product.update({
              where: { id: toParentId },
              data: { isParent: true },
            })
          }

          // 3. Enqueue OutboundSyncQueue for every active channel listing.
          if (product.channelListings.length > 0) {
            const queueRows = await tx.outboundSyncQueue.createManyAndReturn({
              data: product.channelListings.map((cl) => ({
                productId,
                channelListingId: cl.id,
                targetChannel: cl.channel as any,
                targetRegion: cl.marketplace ?? null,
                syncType: 'LISTING_SYNC',
                syncStatus: 'PENDING' as const,
                payload: {
                  kind: 'PARENT_ATTACH',
                  toParentId,
                  attributes: cleanedAttrs,
                  source: 'catalog-organize',
                  sessionId: session.id,
                },
              })),
            })
            queueIds.push(...queueRows.map((r) => r.id))
          }
        })

        // 4. Record the change with before/after snapshot.
        await prisma.catalogOrganizeChange.create({
          data: {
            sessionId: session.id,
            productId,
            toParentId,
            fromParentId: product.parentId ?? null,
            fromVariantAttributes: (product.variantAttributes as any) ?? null,
            attributes: cleanedAttrs as any,
            status: 'APPLIED',
            queueIds,
          },
        })

        published++
      } catch (err) {
        fastify.log.error({ err, productId }, '[catalog/organize/publish] change failed')
        // Try to snapshot sku from the error context.
        errors.push({
          productId,
          sku: '?',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // If everything failed, mark session as failed for housekeeping.
    if (published === 0 && errors.length > 0) {
      await prisma.catalogOrganizeSession.update({
        where: { id: session.id },
        data: { status: 'FAILED' },
      })
    }

    return {
      sessionId: session.id,
      published,
      errors,
      undoExpiresAt: undoExpiresAt.toISOString(),
    }
  })

  // ── GET /api/catalog/organize/sessions ──────────────────────────
  // Returns recent sessions enriched with product sku + name.
  // productId is a plain-string FK (no Prisma relation) so we
  // batch-fetch Product rows after the session query.
  fastify.get('/organize/sessions', async (_request, _reply) => {
    const sessions = await prisma.catalogOrganizeSession.findMany({
      where: { status: { in: ['PUBLISHED', 'UNDONE', 'FAILED'] } },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      include: {
        changes: {
          select: {
            id: true,
            productId: true,
            toParentId: true,
            fromParentId: true,
            attributes: true,
            status: true,
            undoneAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    // Collect all unique product IDs (children + parents) for enrichment.
    const idSet = new Set<string>()
    for (const s of sessions) {
      for (const c of s.changes) {
        idSet.add(c.productId)
        idSet.add(c.toParentId)
        if (c.fromParentId) idSet.add(c.fromParentId)
      }
    }

    const products = idSet.size > 0
      ? await prisma.product.findMany({
          where: { id: { in: Array.from(idSet) } },
          select: { id: true, sku: true, name: true },
        })
      : []
    const pmap = new Map(products.map((p) => [p.id, p]))

    const enriched = sessions.map((s) => ({
      ...s,
      changes: s.changes.map((c) => ({
        ...c,
        productSku:  pmap.get(c.productId)?.sku  ?? c.productId,
        productName: pmap.get(c.productId)?.name ?? '',
        toParentSku: pmap.get(c.toParentId)?.sku ?? c.toParentId,
      })),
    }))

    return { sessions: enriched }
  })

  // ── Shared revert helper ─────────────────────────────────────────
  // Used by both session-level and change-level undo endpoints.
  async function revertChange(
    change: {
      id: string
      productId: string
      toParentId: string
      fromParentId: string | null
      fromVariantAttributes: unknown
    },
    sessionId: string,
    now: Date,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: change.productId },
        data: {
          parentId: change.fromParentId ?? null,
          variantAttributes: (change.fromVariantAttributes as any) ?? null,
        },
      })
      const listings = await tx.channelListing.findMany({
        where: { productId: change.productId },
        select: { id: true, channel: true, marketplace: true },
      })
      if (listings.length > 0) {
        await tx.outboundSyncQueue.createMany({
          data: listings.map((cl) => ({
            productId: change.productId,
            channelListingId: cl.id,
            targetChannel: cl.channel as any,
            targetRegion: cl.marketplace ?? null,
            syncType: 'LISTING_SYNC',
            syncStatus: 'PENDING' as const,
            payload: {
              kind: 'PARENT_DETACH',
              fromParentId: change.toParentId,
              toParentId: change.fromParentId ?? null,
              source: 'catalog-organize-undo',
              sessionId,
            },
          })),
        })
      }
      await tx.catalogOrganizeChange.update({
        where: { id: change.id },
        data: { status: 'UNDONE', undoneAt: now },
      })
    })
  }

  // ── POST /api/catalog/organize/undo/:sessionId ───────────────────
  // Undo all changes in a session (batch revert).
  fastify.post<{ Params: { sessionId: string } }>(
    '/organize/undo/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params
      const session = await prisma.catalogOrganizeSession.findUnique({
        where: { id: sessionId },
        include: { changes: true },
      })
      if (!session) return reply.code(404).send({ error: 'Session not found' })
      if (session.status === 'UNDONE') {
        return reply.code(409).send({ error: 'Session already undone' })
      }
      const now = new Date()
      if (now > session.undoExpiresAt) {
        return reply.code(409).send({
          error: `Undo window expired at ${session.undoExpiresAt.toISOString()}`,
        })
      }

      let undone = 0
      const errors: Array<{ changeId: string; error: string }> = []

      for (const change of session.changes) {
        if (change.status === 'UNDONE') { undone++; continue }
        try {
          await revertChange(change, sessionId, now)
          undone++
        } catch (err) {
          errors.push({
            changeId: change.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (errors.length === 0) {
        await prisma.catalogOrganizeSession.update({
          where: { id: sessionId },
          data: { status: 'UNDONE', undoneAt: now },
        })
      }

      return { undone, errors }
    },
  )

  // ── POST /api/catalog/organize/undo/:sessionId/change/:changeId ──
  // Undo a single change within a session (granular revert).
  fastify.post<{ Params: { sessionId: string; changeId: string } }>(
    '/organize/undo/:sessionId/change/:changeId',
    async (request, reply) => {
      const { sessionId, changeId } = request.params
      const session = await prisma.catalogOrganizeSession.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, undoExpiresAt: true },
      })
      if (!session) return reply.code(404).send({ error: 'Session not found' })
      const now = new Date()
      if (now > session.undoExpiresAt) {
        return reply.code(409).send({
          error: `Undo window expired at ${session.undoExpiresAt.toISOString()}`,
        })
      }

      const change = await prisma.catalogOrganizeChange.findUnique({
        where: { id: changeId },
      })
      if (!change || change.sessionId !== sessionId) {
        return reply.code(404).send({ error: 'Change not found in this session' })
      }
      if (change.status === 'UNDONE') {
        return reply.code(409).send({ error: 'Change already undone' })
      }

      try {
        await revertChange(change, sessionId, now)
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // If all changes in session are now UNDONE, flip the session too.
      const remaining = await prisma.catalogOrganizeChange.count({
        where: { sessionId, status: 'APPLIED' },
      })
      if (remaining === 0) {
        await prisma.catalogOrganizeSession.update({
          where: { id: sessionId },
          data: { status: 'UNDONE', undoneAt: now },
        })
      }

      return { undone: 1, errors: [] }
    },
  )
}

export default catalogOrganizeRoutes
