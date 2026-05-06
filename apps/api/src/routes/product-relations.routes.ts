/**
 * H.11 — related products CRUD.
 *
 *   GET    /api/products/:id/relations
 *     → { outgoing: [...], incoming: [...] }
 *
 *     `outgoing` are relations where this product is the `from` side
 *     (the ones surfaced on this product's detail page). `incoming`
 *     are relations *to* this product, useful for "linked from N
 *     other products" awareness when editing.
 *
 *   POST   /api/products/:id/relations
 *     body: { toProductId, type, displayOrder?, notes?, reciprocal? }
 *     → { created: ProductRelation, reciprocal?: ProductRelation }
 *
 *     `reciprocal: true` creates the reverse relation (`from=toId`,
 *     `to=fromId`) of the same type in the same call. Most cross-
 *     sells should be reciprocal — if jacket → gloves, then gloves
 *     should also surface jacket.
 *
 *   PATCH  /api/products/relations/:id
 *     body: { displayOrder?, notes?, type? }
 *
 *   DELETE /api/products/relations/:id
 *     query: ?reciprocal=true also tears down the reverse pair if one
 *     exists (matched on the inverted from/to + same type).
 *
 * Validation:
 *   - 404 when either product is missing
 *   - 400 on self-reference (from === to)
 *   - 409 when (from, to, type) already exists (Prisma's unique
 *     index throws P2002 — we surface as 409)
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const ALLOWED_TYPES = new Set([
  'CROSS_SELL',
  'ACCESSORY',
  'REPLACEMENT',
  'BUNDLE_PART',
  'UPSELL',
  'RECOMMENDED',
])

interface CreateBody {
  toProductId?: string
  type?: string
  displayOrder?: number
  notes?: string
  reciprocal?: boolean
}

interface UpdateBody {
  displayOrder?: number
  notes?: string | null
  type?: string
}

/**
 * Slim Product summary for the relation lists. We hydrate the related
 * product so the drawer can render image + name + price without a
 * second round-trip per row.
 */
const RELATED_PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  basePrice: true,
  totalStock: true,
  status: true,
  images: {
    where: { type: 'MAIN' },
    take: 1,
    select: { url: true },
  },
} as const

const productRelationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/relations',
    async (request, reply) => {
      const { id } = request.params
      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      const [outgoing, incoming] = await Promise.all([
        prisma.productRelation.findMany({
          where: { fromProductId: id },
          orderBy: [{ type: 'asc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            toProduct: { select: RELATED_PRODUCT_SELECT },
          },
        }),
        prisma.productRelation.findMany({
          where: { toProductId: id },
          orderBy: [{ type: 'asc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            fromProduct: { select: RELATED_PRODUCT_SELECT },
          },
        }),
      ])

      const hydrate = (
        rows: Array<{ toProduct?: any; fromProduct?: any } & Record<string, any>>,
        otherKey: 'toProduct' | 'fromProduct',
      ) =>
        rows.map((r) => ({
          ...r,
          [otherKey]: r[otherKey]
            ? {
                ...r[otherKey],
                basePrice:
                  r[otherKey].basePrice != null
                    ? Number(r[otherKey].basePrice)
                    : null,
                imageUrl: r[otherKey].images?.[0]?.url ?? null,
                images: undefined,
              }
            : null,
        }))

      return {
        outgoing: hydrate(outgoing, 'toProduct'),
        incoming: hydrate(incoming, 'fromProduct'),
      }
    },
  )

  fastify.post<{ Params: { id: string }; Body: CreateBody }>(
    '/products/:id/relations',
    async (request, reply) => {
      const { id } = request.params
      const body = request.body ?? {}
      const toProductId = (body.toProductId ?? '').trim()
      const type = (body.type ?? '').toUpperCase()
      if (!toProductId) {
        return reply.code(400).send({ error: 'toProductId required' })
      }
      if (!ALLOWED_TYPES.has(type)) {
        return reply.code(400).send({
          error: `type must be one of ${Array.from(ALLOWED_TYPES).join(', ')}`,
        })
      }
      if (id === toProductId) {
        return reply.code(400).send({ error: 'cannot relate a product to itself' })
      }
      const both = await prisma.product.findMany({
        where: { id: { in: [id, toProductId] } },
        select: { id: true },
      })
      if (both.length !== 2) {
        return reply.code(404).send({ error: 'one or both products not found' })
      }

      const data = {
        fromProductId: id,
        toProductId,
        type,
        displayOrder:
          typeof body.displayOrder === 'number' ? body.displayOrder : 0,
        notes: typeof body.notes === 'string' ? body.notes : null,
      }
      try {
        const created = await prisma.productRelation.create({ data })
        let reciprocal = null
        if (body.reciprocal) {
          // Don't fail the whole call if the reciprocal already exists.
          try {
            reciprocal = await prisma.productRelation.create({
              data: {
                fromProductId: toProductId,
                toProductId: id,
                type,
                displayOrder: data.displayOrder,
                notes: data.notes,
              },
            })
          } catch (err: any) {
            if (err?.code !== 'P2002') throw err
            // Reciprocal already exists — that's fine.
          }
        }
        return { created, reciprocal }
      } catch (err: any) {
        if (err?.code === 'P2002') {
          return reply
            .code(409)
            .send({ error: 'Relation of this type already exists' })
        }
        throw err
      }
    },
  )

  fastify.patch<{ Params: { id: string }; Body: UpdateBody }>(
    '/products/relations/:id',
    async (request, reply) => {
      const { id } = request.params
      const body = request.body ?? {}
      const data: Record<string, unknown> = {}
      if (typeof body.displayOrder === 'number') {
        data.displayOrder = body.displayOrder
      }
      if (body.notes !== undefined) data.notes = body.notes
      if (typeof body.type === 'string') {
        const t = body.type.toUpperCase()
        if (!ALLOWED_TYPES.has(t)) {
          return reply.code(400).send({
            error: `type must be one of ${Array.from(ALLOWED_TYPES).join(', ')}`,
          })
        }
        data.type = t
      }
      try {
        const row = await prisma.productRelation.update({
          where: { id },
          data,
        })
        return row
      } catch (err: any) {
        if (err?.code === 'P2025') {
          return reply.code(404).send({ error: 'relation not found' })
        }
        if (err?.code === 'P2002') {
          return reply
            .code(409)
            .send({ error: 'A relation with this type already exists between these products' })
        }
        throw err
      }
    },
  )

  fastify.delete<{
    Params: { id: string }
    Querystring: { reciprocal?: string }
  }>('/products/relations/:id', async (request, reply) => {
    const { id } = request.params
    const dropReciprocal = request.query?.reciprocal === 'true'
    const existing = await prisma.productRelation.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'relation not found' })
    await prisma.productRelation.delete({ where: { id } })
    let droppedReciprocal = 0
    if (dropReciprocal) {
      const result = await prisma.productRelation.deleteMany({
        where: {
          fromProductId: existing.toProductId,
          toProductId: existing.fromProductId,
          type: existing.type,
        },
      })
      droppedReciprocal = result.count
    }
    return { ok: true, droppedReciprocal }
  })
}

export default productRelationsRoutes
