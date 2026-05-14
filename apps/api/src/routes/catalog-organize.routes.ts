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
  // Returns recent sessions for the Phase 5 history panel.
  fastify.get('/organize/sessions', async (_request, _reply) => {
    const sessions = await prisma.catalogOrganizeSession.findMany({
      where: { status: { in: ['PUBLISHED', 'UNDONE'] } },
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
          },
        },
      },
    })
    return { sessions }
  })

  // ── POST /api/catalog/organize/undo/:sessionId ───────────────────
  // Restore pre-publish state for all changes in a session.
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
          await prisma.$transaction(async (tx) => {
            // Restore product's parentId and variantAttributes.
            await tx.product.update({
              where: { id: change.productId },
              data: {
                parentId: change.fromParentId ?? null,
                variantAttributes: (change.fromVariantAttributes as any) ?? null,
              },
            })
            // Enqueue reversal sync row for each channel listing.
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
}

export default catalogOrganizeRoutes
