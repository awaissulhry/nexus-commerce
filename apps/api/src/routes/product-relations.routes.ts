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

  // W11.1 — heuristic cross-sell suggestions.
  //
  //   GET /api/products/:id/relations/suggest?type=CROSS_SELL&limit=10
  //     → { suggestions: Array<{ product, score, reasons[] }> }
  //
  // Pure ranking — no AI call, no writes. The operator is the
  // judge; this surface just curates the search space from 281+
  // SKUs down to 10 ranked candidates so the human picker isn't
  // staring at a flat list. Scoring weights:
  //   +30  same brand
  //   +25  same productType
  //   +20  basePrice within ±30% of source (cross-sell beat
  //         tends to land at similar price tiers)
  //   +10  has main image (otherwise the PDP card is bald)
  //   +10  has description (otherwise the AI cross-sell ranker
  //         can't tell what it is)
  //   +5   has at least 1 channel listing (some channel exposure)
  //
  // Excludes: self, already-related (any type), DRAFT-only products,
  // soft-deleted. Orders by computed score desc, then sku asc for
  // stability.
  fastify.get<{
    Params: { id: string }
    Querystring: { type?: string; limit?: string }
  }>('/products/:id/relations/suggest', async (request, reply) => {
    const { id } = request.params
    const requestedType = (request.query?.type ?? 'CROSS_SELL').toUpperCase()
    if (!ALLOWED_TYPES.has(requestedType)) {
      return reply.code(400).send({
        error: `type must be one of ${Array.from(ALLOWED_TYPES).join(', ')}`,
      })
    }
    const limit = Math.min(
      Math.max(Number(request.query?.limit ?? 10), 1),
      50,
    )

    const source = await prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        sku: true,
        brand: true,
        productType: true,
        basePrice: true,
      },
    })
    if (!source) return reply.code(404).send({ error: 'Product not found' })

    const sourcePrice = source.basePrice ? Number(source.basePrice) : null

    // Already-related set (any direction, any type) so we never
    // re-suggest a sibling already linked.
    const existingRelations = await prisma.productRelation.findMany({
      where: {
        OR: [{ fromProductId: id }, { toProductId: id }],
      },
      select: { fromProductId: true, toProductId: true },
    })
    const excluded = new Set<string>([id])
    for (const r of existingRelations) {
      excluded.add(r.fromProductId)
      excluded.add(r.toProductId)
    }

    // Pull a generously-sized candidate pool. Order by sku for
    // determinism so two operators see the same ranking on the
    // same data state.
    const candidates = await prisma.product.findMany({
      where: {
        id: { notIn: Array.from(excluded) },
        deletedAt: null,
        status: { in: ['ACTIVE', 'INACTIVE'] }, // skip DRAFT
        // Standalone or parents only — children are surfaced via
        // their parent so we don't suggest variant rows individually.
        parentId: null,
      },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        productType: true,
        basePrice: true,
        description: true,
        status: true,
        images: { where: { type: 'MAIN' }, take: 1, select: { url: true } },
        _count: { select: { channelListings: true } },
      },
      orderBy: { sku: 'asc' },
      take: 200,
    })

    // Score each candidate, then sort + slice.
    const scored = candidates.map((c) => {
      const reasons: string[] = []
      let score = 0
      if (source.brand && c.brand && source.brand === c.brand) {
        score += 30
        reasons.push('same brand')
      }
      if (
        source.productType &&
        c.productType &&
        source.productType === c.productType
      ) {
        score += 25
        reasons.push('same product type')
      }
      const cPrice = c.basePrice ? Number(c.basePrice) : null
      if (sourcePrice && cPrice && sourcePrice > 0) {
        const ratio = cPrice / sourcePrice
        if (ratio >= 0.7 && ratio <= 1.3) {
          score += 20
          reasons.push('similar price tier')
        }
      }
      if (c.images?.length > 0) {
        score += 10
        reasons.push('has image')
      }
      if (
        typeof c.description === 'string' &&
        c.description.trim().length > 50
      ) {
        score += 10
        reasons.push('has description')
      }
      if ((c._count?.channelListings ?? 0) > 0) {
        score += 5
        reasons.push('listed on channels')
      }
      return {
        product: {
          id: c.id,
          sku: c.sku,
          name: c.name,
          brand: c.brand,
          basePrice: cPrice,
          status: c.status,
          imageUrl: c.images?.[0]?.url ?? null,
        },
        score,
        reasons,
      }
    })

    // Filter out zero-score noise (no overlap on any dimension)
    // unless we'd otherwise return an empty list. Sort high → low.
    const positive = scored.filter((s) => s.score > 0)
    const ranked = (positive.length > 0 ? positive : scored)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.product.sku.localeCompare(b.product.sku)
      })
      .slice(0, limit)

    return {
      suggestions: ranked,
      totalScored: candidates.length,
      excludedCount: excluded.size,
    }
  })
}

export default productRelationsRoutes
