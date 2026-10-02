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
import { createRepricingRule, patchRepricingRule, type RepricingRuleCreate, type RepricingRulePatch } from '../services/repricing-rule.service.js'
import { isRefused } from '../services/automation/service-outcome.js'

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

  // R17 — create and edit moved unchanged into repricing-rule.service.ts (save-price-rule saves through them).
  fastify.post('/products/:id/repricing-rules', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const outcome = await createRepricingRule(productId, request.body as RepricingRuleCreate)
    if (isRefused(outcome)) return reply.code(outcome.status).send(outcome.body)
    return reply.code(201).send(outcome.value)
  })

  fastify.patch('/repricing-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const outcome = await patchRepricingRule(id, request.body as RepricingRulePatch)
    if (isRefused(outcome)) return reply.code(outcome.status).send(outcome.body)
    return outcome.value
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
