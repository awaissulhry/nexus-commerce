/**
 * W4.8 — Repricing rule + decision API.
 *
 * CRUD on the W4.6 RepricingRule model + read access to
 * RepricingDecision history. Triggers RepricingEngineService.evaluate
 * via POST /repricing-rules/:id/evaluate so the operator can preview
 * what the engine would do with the current market context (the
 * Amazon buy-box poller / cron — W4.10 — pushes evaluations
 * automatically).
 *
 * Lives at /repricing-rules/* (not /pricing-rules) because the
 * legacy /pricing-rules namespace already exists in the codebase
 * for the older repricing.service.ts shape; -rules at the new path
 * keeps both APIs reachable until W4.x reconciles them.
 *
 * Endpoints (all under /api):
 *
 *   RepricingRule:
 *     GET    /products/:id/repricing-rules    list rules for product
 *     POST   /products/:id/repricing-rules    create
 *     PATCH  /repricing-rules/:id             update (channel +
 *                                              marketplace + product
 *                                              are immutable —
 *                                              they're the @@unique
 *                                              key)
 *     DELETE /repricing-rules/:id             cascades decisions
 *
 *   RepricingDecision:
 *     GET    /repricing-rules/:id/decisions   recent decisions
 *                                              (?limit, ?cursor)
 *
 *   Engine:
 *     POST   /repricing-rules/:id/evaluate    { currentPrice,
 *                                               buyBoxPrice?,
 *                                               lowestCompPrice?,
 *                                               competitorCount?,
 *                                               applyToProduct? }
 *           Runs RepricingEngineService.evaluate, writes a
 *           RepricingDecision, returns the result. Useful for
 *           operator preview ("what would happen if I matched the
 *           buy box at €89.99?") + for the cron's per-rule push.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { repricingEngineService } from '../services/repricing-engine.service.js'

const VALID_STRATEGIES = new Set([
  'match_buy_box',
  'beat_lowest_by_pct',
  'beat_lowest_by_amount',
  'fixed_to_buy_box_minus',
  'manual',
])

const repricingRulesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/products/:id/repricing-rules', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    })
    if (!product) return reply.code(404).send({ error: 'product not found' })
    const rules = await prisma.repricingRule.findMany({
      where: { productId },
      orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
    })
    return { rules }
  })

  fastify.post('/products/:id/repricing-rules', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const body = request.body as {
      channel?: string
      marketplace?: string | null
      enabled?: boolean
      minPrice?: number | string
      maxPrice?: number | string
      strategy?: string
      beatPct?: number | string | null
      beatAmount?: number | string | null
      activeFromHour?: number | null
      activeToHour?: number | null
      activeDays?: number[]
      notes?: string | null
    }
    if (!body.channel?.trim())
      return reply.code(400).send({ error: 'channel is required' })
    const minPrice = Number(body.minPrice)
    const maxPrice = Number(body.maxPrice)
    if (!(minPrice >= 0))
      return reply.code(400).send({ error: 'minPrice must be >= 0' })
    if (!(maxPrice >= minPrice))
      return reply.code(400).send({ error: 'maxPrice must be >= minPrice' })
    if (!body.strategy || !VALID_STRATEGIES.has(body.strategy))
      return reply.code(400).send({
        error: `strategy must be one of ${[...VALID_STRATEGIES].join(', ')}`,
      })
    // Strategy-specific param presence checks. Server-side belt-
    // and-braces — the UI should already be enforcing these, but
    // direct API callers shouldn't be able to create a rule that
    // can never decide.
    if (body.strategy === 'beat_lowest_by_pct' && body.beatPct == null)
      return reply
        .code(400)
        .send({ error: 'beatPct is required for beat_lowest_by_pct' })
    if (
      (body.strategy === 'beat_lowest_by_amount' ||
        body.strategy === 'fixed_to_buy_box_minus') &&
      body.beatAmount == null
    )
      return reply
        .code(400)
        .send({ error: `beatAmount is required for ${body.strategy}` })

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    })
    if (!product) return reply.code(404).send({ error: 'product not found' })

    try {
      const rule = await prisma.repricingRule.create({
        data: {
          productId,
          channel: body.channel.toUpperCase(),
          marketplace: body.marketplace?.toUpperCase() || null,
          enabled: body.enabled ?? true,
          minPrice,
          maxPrice,
          strategy: body.strategy,
          beatPct: body.beatPct == null ? null : Number(body.beatPct),
          beatAmount:
            body.beatAmount == null ? null : Number(body.beatAmount),
          activeFromHour: body.activeFromHour ?? null,
          activeToHour: body.activeToHour ?? null,
          activeDays: Array.isArray(body.activeDays) ? body.activeDays : [],
          notes: body.notes?.trim() || null,
        },
      })
      return reply.code(201).send({ rule })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply.code(409).send({
          error: `a rule already exists for (channel=${body.channel}, marketplace=${body.marketplace ?? 'any'})`,
        })
      throw err
    }
  })

  fastify.patch('/repricing-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      enabled?: boolean
      minPrice?: number | string
      maxPrice?: number | string
      strategy?: string
      beatPct?: number | string | null
      beatAmount?: number | string | null
      activeFromHour?: number | null
      activeToHour?: number | null
      activeDays?: number[]
      notes?: string | null
    }
    // productId, channel, marketplace are part of the @@unique key
    // — to "move" a rule, delete + create.
    const data: Record<string, unknown> = {}
    if (body.enabled !== undefined) data.enabled = !!body.enabled
    if (body.minPrice !== undefined) {
      const v = Number(body.minPrice)
      if (!(v >= 0))
        return reply.code(400).send({ error: 'minPrice must be >= 0' })
      data.minPrice = v
    }
    if (body.maxPrice !== undefined) {
      const v = Number(body.maxPrice)
      if (!(v >= 0))
        return reply.code(400).send({ error: 'maxPrice must be >= 0' })
      data.maxPrice = v
    }
    if (body.strategy !== undefined) {
      if (!VALID_STRATEGIES.has(body.strategy))
        return reply.code(400).send({
          error: `strategy must be one of ${[...VALID_STRATEGIES].join(', ')}`,
        })
      data.strategy = body.strategy
    }
    if (body.beatPct !== undefined)
      data.beatPct = body.beatPct == null ? null : Number(body.beatPct)
    if (body.beatAmount !== undefined)
      data.beatAmount =
        body.beatAmount == null ? null : Number(body.beatAmount)
    if (body.activeFromHour !== undefined)
      data.activeFromHour = body.activeFromHour
    if (body.activeToHour !== undefined)
      data.activeToHour = body.activeToHour
    if (body.activeDays !== undefined)
      data.activeDays = Array.isArray(body.activeDays) ? body.activeDays : []
    if (body.notes !== undefined) data.notes = body.notes?.trim() || null
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const rule = await prisma.repricingRule.update({
        where: { id },
        data,
      })
      return { rule }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'repricing-rule not found' })
      throw err
    }
  })

  fastify.delete('/repricing-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.repricingRule.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'repricing-rule not found' })
      throw err
    }
  })

  // ── Decisions ─────────────────────────────────────────────────

  fastify.get('/repricing-rules/:id/decisions', async (request) => {
    const { id } = request.params as { id: string }
    const q = request.query as { limit?: string; cursor?: string }
    const limit = Math.min(
      Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
      200,
    )
    const decisions = await prisma.repricingDecision.findMany({
      where: { ruleId: id },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    })
    const hasMore = decisions.length > limit
    const trimmed = hasMore ? decisions.slice(0, limit) : decisions
    return {
      decisions: trimmed,
      nextCursor: hasMore ? trimmed[trimmed.length - 1]?.id ?? null : null,
    }
  })

  // ── Engine evaluate (preview / cron-driven push) ──────────────

  fastify.post('/repricing-rules/:id/evaluate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      currentPrice?: number | string
      buyBoxPrice?: number | string | null
      lowestCompPrice?: number | string | null
      competitorCount?: number | null
      applyToProduct?: boolean
    }
    const currentPrice = Number(body.currentPrice)
    if (!(currentPrice >= 0))
      return reply
        .code(400)
        .send({ error: 'currentPrice is required and must be >= 0' })
    try {
      const result = await repricingEngineService.evaluate(
        id,
        {
          currentPrice,
          buyBoxPrice:
            body.buyBoxPrice == null ? null : Number(body.buyBoxPrice),
          lowestCompPrice:
            body.lowestCompPrice == null
              ? null
              : Number(body.lowestCompPrice),
          competitorCount: body.competitorCount ?? null,
        },
        { applyToProduct: !!body.applyToProduct },
      )
      return result
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg })
      throw err
    }
  })
}

export default repricingRulesRoutes
