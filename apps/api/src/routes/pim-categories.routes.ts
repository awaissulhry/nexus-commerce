/**
 * PIM Category taxonomy routes.
 *
 * The operator's own infinite-depth merchandising tree. Deliberately a
 * separate file from categories.routes.ts (which serves marketplace
 * CategorySchema attribute schemas) so the two never get conflated.
 *
 * Mounted with the /api prefix in index.ts.
 *
 *   GET    /api/pim/categories/tree
 *   GET    /api/pim/categories/:id/breadcrumb
 *   POST   /api/pim/categories
 *   PATCH  /api/pim/categories/:id
 *   POST   /api/pim/categories/:id/move
 *   DELETE /api/pim/categories/:id
 *   POST   /api/products/:id/categories          (assign membership set)
 *   DELETE /api/products/:id/categories/:categoryId
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  categoryTreeService,
  CategoryTreeError,
} from '../services/category-tree.service.js'
import { logger } from '../utils/logger.js'

function handleError(reply: any, err: unknown) {
  if (err instanceof CategoryTreeError) {
    return reply.code(err.status).send({ error: err.message })
  }
  // Prisma unique-violation on (parentId, slug).
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  ) {
    return reply
      .code(409)
      .send({ error: 'A sibling category with that slug already exists' })
  }
  logger.error('[pim-categories] unexpected error', {
    error: err instanceof Error ? err.message : String(err),
  })
  return reply.code(500).send({ error: 'Internal error' })
}

const pimCategoriesRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Tree ──────────────────────────────────────────────────────────────
  fastify.get('/pim/categories/tree', async (request, reply) => {
    const q = request.query as { activeOnly?: string }
    try {
      const tree = await categoryTreeService.tree({
        activeOnly: q.activeOnly === '1' || q.activeOnly === 'true',
      })
      return reply.send({ tree })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  fastify.get('/pim/categories/:id/breadcrumb', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send({ breadcrumb: await categoryTreeService.breadcrumb(id) })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // ── Create ──────────────────────────────────────────────────────────────
  fastify.post('/pim/categories', async (request, reply) => {
    const body = request.body as {
      parentId?: string | null
      slug?: string
      code?: string | null
      name?: Record<string, unknown>
      description?: Record<string, unknown>
      attributes?: Record<string, unknown>
      sortOrder?: number
      isActive?: boolean
    }
    if (!body?.slug || typeof body.slug !== 'string') {
      return reply.code(400).send({ error: 'slug is required' })
    }
    try {
      const node = await categoryTreeService.create({
        parentId: body.parentId ?? null,
        slug: body.slug,
        code: body.code ?? null,
        name: body.name as any,
        description: body.description as any,
        attributes: body.attributes as any,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      })
      return reply.code(201).send({ category: node })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // ── Update ────────────────────────────────────────────────────────────────
  fastify.patch('/pim/categories/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>
    try {
      const node = await categoryTreeService.update(id, {
        slug: body.slug as string | undefined,
        code: body.code as string | null | undefined,
        name: body.name as any,
        description: body.description as any,
        attributes: body.attributes as any,
        sortOrder: body.sortOrder as number | undefined,
        isActive: body.isActive as boolean | undefined,
      })
      return reply.send({ category: node })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // ── Move (re-parent subtree) ──────────────────────────────────────────────
  fastify.post('/pim/categories/:id/move', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { newParentId?: string | null }
    try {
      await categoryTreeService.move(id, body?.newParentId ?? null)
      return reply.send({ ok: true })
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // ── Delete ────────────────────────────────────────────────────────────────
  fastify.delete('/pim/categories/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await categoryTreeService.remove(id)
      return reply.code(204).send()
    } catch (err) {
      return handleError(reply, err)
    }
  })

  // ── Product membership ────────────────────────────────────────────────────
  fastify.post('/products/:id/categories', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      categoryIds?: string[]
      primaryId?: string | null
    }
    if (!Array.isArray(body?.categoryIds)) {
      return reply.code(400).send({ error: 'categoryIds[] is required' })
    }
    try {
      const result = await categoryTreeService.assign(id, body.categoryIds, {
        primaryId: body.primaryId ?? null,
        source: 'OPERATOR',
      })
      return reply.send(result)
    } catch (err) {
      return handleError(reply, err)
    }
  })

  fastify.delete(
    '/products/:id/categories/:categoryId',
    async (request, reply) => {
      const { id, categoryId } = request.params as {
        id: string
        categoryId: string
      }
      try {
        const result = await categoryTreeService.unassign(id, categoryId, {
          source: 'OPERATOR',
        })
        return reply.send(result)
      } catch (err) {
        return handleError(reply, err)
      }
    },
  )
}

export default pimCategoriesRoutes
