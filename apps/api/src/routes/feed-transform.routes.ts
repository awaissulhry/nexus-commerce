/**
 * CE.1 — Feed Transform Engine API routes.
 *
 *   GET    /api/feed-transform/rules            list rules (channel filter)
 *   POST   /api/feed-transform/rules            create rule
 *   PATCH  /api/feed-transform/rules/:id        update rule
 *   DELETE /api/feed-transform/rules/:id        delete rule
 *   POST   /api/feed-transform/preview          evaluate rules for product×channel
 *   GET    /api/feed-transform/schema/:channel  field definitions for channel
 *   POST   /api/feed-transform/seed-schemas     seed built-in Amazon/eBay/Shopify schemas
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  evaluateRules,
} from '../services/feed/feed-transform.service.js'
import {
  getSchemaForChannel,
  seedBuiltInSchemas,
  validatePackage,
} from '../services/feed/channel-schema.service.js'

const feedTransformRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List rules ────────────────────────────────────────────────────────────
  fastify.get('/rules', async (req) => {
    const { channel, enabled } = req.query as {
      channel?: string
      enabled?: string
    }
    const rules = await listRules(prisma, {
      channel,
      enabled: enabled === 'true' ? true : enabled === 'false' ? false : undefined,
    })
    return { rules }
  })

  // ── Create rule ───────────────────────────────────────────────────────────
  fastify.post('/rules', async (req, reply) => {
    const body = req.body as {
      name: string
      description?: string
      channel: string
      marketplace?: string | null
      field: string
      priority?: number
      enabled?: boolean
      condition?: { field: string; op: string; value?: unknown } | null
      action: { type: string; value?: string; template?: string }
      createdBy?: string
    }
    if (!body.name || !body.channel || !body.field || !body.action?.type) {
      return reply.status(400).send({ error: 'name, channel, field, and action.type are required' })
    }
    const rule = await createRule(prisma, body as Parameters<typeof createRule>[1])
    return reply.status(201).send({ rule })
  })

  // ── Update rule ───────────────────────────────────────────────────────────
  fastify.patch('/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as Parameters<typeof updateRule>[2]
    const rule = await updateRule(prisma, id, body)
    return { rule }
  })

  // ── Delete rule ───────────────────────────────────────────────────────────
  fastify.delete('/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await deleteRule(prisma, id)
    return reply.status(204).send()
  })

  // ── Preview (evaluate rules for product × channel) ────────────────────────
  fastify.post('/preview', async (req, reply) => {
    const body = req.body as {
      productId?: string
      channel: string
      marketplace?: string | null
    }
    if (!body.channel) {
      return reply.status(400).send({ error: 'channel is required' })
    }

    // Load product (or accept inline product data for testing)
    let product: Record<string, unknown> | null = null
    if (body.productId) {
      product = await prisma.product.findUnique({
        where: { id: body.productId },
        select: {
          id: true,
          name: true,
          brand: true,
          productType: true,
          description: true,
          ean: true,
          sku: true,
        },
      })
      if (!product) {
        return reply.status(404).send({ error: 'Product not found' })
      }
    } else {
      // Return empty package if no productId — useful for testing rule logic
      product = {}
    }

    const pkg = await evaluateRules(prisma, product, body.channel, body.marketplace ?? null)
    const errors = await validatePackage(prisma, body.channel, body.marketplace ?? null, pkg.resolved)

    return { package: pkg, validationErrors: errors }
  })

  // ── Schema for channel ─────────────────────────────────────────────────────
  fastify.get('/schema/:channel', async (req) => {
    const { channel } = req.params as { channel: string }
    const { marketplace } = req.query as { marketplace?: string }
    const schema = await getSchemaForChannel(prisma, channel, marketplace ?? null)
    return { schema }
  })

  // ── Seed built-in schemas ──────────────────────────────────────────────────
  fastify.post('/seed-schemas', async (_req, reply) => {
    const result = await seedBuiltInSchemas(prisma)
    return reply.status(200).send({ ok: true, ...result })
  })
}

export default feedTransformRoutes
