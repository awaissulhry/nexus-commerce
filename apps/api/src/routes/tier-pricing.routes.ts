/**
 * W4.3 — Tier pricing + customer group CRUD API.
 *
 * Endpoints (all under /api):
 *
 *   CustomerGroup:
 *     GET    /customer-groups
 *     POST   /customer-groups
 *     PATCH  /customer-groups/:id
 *     DELETE /customer-groups/:id        cascades to tier rows
 *                                         scoped to this group;
 *                                         generic rows survive.
 *
 *   ProductTierPrice (per-product scoped):
 *     GET    /products/:id/tier-prices
 *     POST   /products/:id/tier-prices
 *     PATCH  /tier-prices/:id            cannot change productId
 *                                         or minQty/customerGroupId
 *                                         (would invalidate the
 *                                         @@unique key); price-only
 *                                         updates allowed.
 *     DELETE /tier-prices/:id
 *
 *   Resolver:
 *     GET    /products/:id/resolve-price?qty=N&customerGroup=<id>
 *            Returns the tier-pricing-service result for callers
 *            that need to compute the effective price (drawer
 *            preview, future quote/order flows).
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { tierPricingService } from '../services/tier-pricing.service.js'

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

const tierPricingRoutes: FastifyPluginAsync = async (fastify) => {
  // ── CustomerGroup ───────────────────────────────────────────

  fastify.get('/customer-groups', async () => {
    const groups = await prisma.customerGroup.findMany({
      orderBy: [{ label: 'asc' }],
      include: {
        _count: { select: { tierPrices: true } },
      },
    })
    return { groups }
  })

  fastify.post('/customer-groups', async (request, reply) => {
    const body = request.body as {
      code?: string
      label?: string
      description?: string | null
    }
    if (!body.code || !CODE_PATTERN.test(body.code))
      return reply.code(400).send({
        error:
          'code is required and must be lowercase snake_case (matches /^[a-z][a-z0-9_]{0,63}$/)',
      })
    if (!body.label?.trim())
      return reply.code(400).send({ error: 'label is required' })
    try {
      const group = await prisma.customerGroup.create({
        data: {
          code: body.code,
          label: body.label.trim(),
          description: body.description?.trim() || null,
        },
      })
      return reply.code(201).send({ group })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply.code(409).send({
          error: `customer-group code "${body.code}" already exists`,
        })
      throw err
    }
  })

  fastify.patch('/customer-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      label?: string
      description?: string | null
    }
    const data: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (!body.label.trim())
        return reply.code(400).send({ error: 'label cannot be empty' })
      data.label = body.label.trim()
    }
    if (body.description !== undefined)
      data.description = body.description?.trim() || null
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const group = await prisma.customerGroup.update({ where: { id }, data })
      return { group }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'customer-group not found' })
      throw err
    }
  })

  fastify.delete('/customer-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.customerGroup.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'customer-group not found' })
      throw err
    }
  })

  // ── ProductTierPrice ────────────────────────────────────────

  fastify.get('/products/:id/tier-prices', async (request, reply) => {
    const { id } = request.params as { id: string }
    const product = await prisma.product.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!product) return reply.code(404).send({ error: 'product not found' })
    const tierPrices = await prisma.productTierPrice.findMany({
      where: { productId: id },
      orderBy: [
        // Group-specific rows alongside their generic peers; sort
        // primarily by minQty so the operator scans up the ladder.
        { minQty: 'asc' },
        { customerGroupId: 'asc' },
      ],
      include: {
        customerGroup: { select: { id: true, code: true, label: true } },
      },
    })
    return { tierPrices }
  })

  fastify.post('/products/:id/tier-prices', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      minQty?: number
      price?: number | string
      customerGroupId?: string | null
    }
    if (typeof body.minQty !== 'number' || body.minQty < 1)
      return reply
        .code(400)
        .send({ error: 'minQty is required and must be >= 1' })
    const priceNum = typeof body.price === 'string' ? Number(body.price) : body.price
    if (typeof priceNum !== 'number' || !(priceNum >= 0))
      return reply
        .code(400)
        .send({ error: 'price is required and must be >= 0' })

    if (body.customerGroupId) {
      const grp = await prisma.customerGroup.findUnique({
        where: { id: body.customerGroupId },
        select: { id: true },
      })
      if (!grp)
        return reply.code(400).send({ error: 'customerGroupId does not exist' })
    }

    try {
      const tier = await prisma.productTierPrice.create({
        data: {
          productId: id,
          minQty: body.minQty,
          price: priceNum,
          customerGroupId: body.customerGroupId ?? null,
        },
        include: {
          customerGroup: { select: { id: true, code: true, label: true } },
        },
      })
      return reply.code(201).send({ tierPrice: tier })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply.code(409).send({
          error: `tier already exists at (minQty=${body.minQty}, group=${body.customerGroupId ?? 'any'})`,
        })
      // P2003 — product or group FK violation surfaces only if we
      // missed validating above; defensive 400.
      if (err?.code === 'P2003')
        return reply.code(400).send({
          error: 'productId or customerGroupId does not exist',
        })
      throw err
    }
  })

  fastify.patch('/tier-prices/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { price?: number | string }
    // minQty + customerGroupId immutable — they're part of the
    // @@unique key + the resolver's bracket logic. To "change" them,
    // delete + create.
    const priceNum =
      typeof body.price === 'string' ? Number(body.price) : body.price
    if (typeof priceNum !== 'number' || !(priceNum >= 0))
      return reply
        .code(400)
        .send({ error: 'price is required and must be >= 0' })
    try {
      const tier = await prisma.productTierPrice.update({
        where: { id },
        data: { price: priceNum },
      })
      return { tierPrice: tier }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'tier-price not found' })
      throw err
    }
  })

  fastify.delete('/tier-prices/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.productTierPrice.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'tier-price not found' })
      throw err
    }
  })

  // ── Resolver ────────────────────────────────────────────────

  fastify.get('/products/:id/resolve-price', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { qty?: string; customerGroup?: string }
    const qty = parseInt(q.qty ?? '1', 10) || 1
    try {
      const result = await tierPricingService.resolve(
        id,
        qty,
        q.customerGroup || null,
      )
      return result
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg })
      throw err
    }
  })
}

export default tierPricingRoutes
