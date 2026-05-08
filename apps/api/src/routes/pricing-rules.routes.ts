/**
 * D.1 — Pricing-rule CRUD (Fastify rebuild).
 *
 * The previous Express router + PricingRulesService were deleted in
 * A.2.a (commit bd1c6d5) because they shipped with a fake Decimal mock
 * that returned 0/false from every math op, and were never registered
 * into the Fastify server (apps/api/src/index.ts:340 only registers
 * `pricingRoutes`). The dashboard at /dashboard/pricing was 404'ing on
 * every CRUD call, which explained the production state of zero
 * PricingRule rows.
 *
 * This rebuild keeps the API contract the existing api-client + dashboard
 * UI expect (`POST /api/pricing-rules` etc) so the frontend works without
 * changes. Rule evaluation is NOT a separate endpoint — the pricing
 * engine evaluates PRICING_RULE source inline (pricing-engine.service.ts:
 * 326-384), so there's no need for the broken /evaluate path.
 *
 *   POST   /api/pricing-rules                      Create rule + optional
 *                                                   productIds/variationIds
 *                                                   join writes
 *   GET    /api/pricing-rules                      List active rules
 *   GET    /api/pricing-rules/variation/:vid       Rules linked to one variation
 *   PUT    /api/pricing-rules/:id                  Update rule (partial body)
 *   DELETE /api/pricing-rules/:id                  Soft delete (isActive=false);
 *                                                   real delete preserves audit.
 */
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { Prisma } from '@prisma/client'

const VALID_TYPES = new Set([
  'MATCH_LOW',
  'PERCENTAGE_BELOW',
  'COST_PLUS_MARGIN',
  'FIXED_PRICE',
  'DYNAMIC_MARGIN',
])

interface CreateRuleBody {
  name?: string
  type?: string
  description?: string
  priority?: number
  minMarginPercent?: number | null
  maxMarginPercent?: number | null
  parameters?: Record<string, unknown>
  productIds?: string[]
  variationIds?: string[]
}

const pricingRulesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/pricing-rules', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as CreateRuleBody
      if (!body.name || typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'name is required' })
      }
      if (!body.type || !VALID_TYPES.has(body.type)) {
        return reply.code(400).send({
          error: `type must be one of ${[...VALID_TYPES].join(', ')}`,
        })
      }
      const priority = Number.isFinite(body.priority) ? Number(body.priority) : 100
      const rule = await prisma.pricingRule.create({
        data: {
          name: body.name,
          type: body.type,
          description: body.description ?? null,
          priority,
          minMarginPercent:
            body.minMarginPercent != null
              ? new Prisma.Decimal(body.minMarginPercent)
              : null,
          maxMarginPercent:
            body.maxMarginPercent != null
              ? new Prisma.Decimal(body.maxMarginPercent)
              : null,
          parameters: (body.parameters ?? {}) as Prisma.InputJsonValue,
          isActive: true,
          products:
            body.productIds && body.productIds.length > 0
              ? {
                  create: body.productIds.map((productId) => ({ productId })),
                }
              : undefined,
          variations:
            body.variationIds && body.variationIds.length > 0
              ? {
                  create: body.variationIds.map((variationId) => ({
                    variationId,
                  })),
                }
              : undefined,
        },
      })
      return rule
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing-rules POST] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/pricing-rules', async (_request, reply) => {
    try {
      const rules = await prisma.pricingRule.findMany({
        where: { isActive: true },
        orderBy: { priority: 'asc' },
      })
      return rules
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing-rules GET] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get<{ Params: { variationId: string } }>(
    '/pricing-rules/variation/:variationId',
    async (request, reply) => {
      try {
        const links = await prisma.pricingRuleVariation.findMany({
          where: { variationId: request.params.variationId },
          include: { rule: true },
          orderBy: { rule: { priority: 'asc' } },
        })
        // Filter out inactive rules (link can outlive deactivation).
        return links.map((l) => l.rule).filter((r) => r.isActive)
      } catch (error: any) {
        fastify.log.error(
          { err: error },
          '[pricing-rules GET variation] failed',
        )
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )

  fastify.put<{ Params: { id: string } }>(
    '/pricing-rules/:id',
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as CreateRuleBody & {
          isActive?: boolean
        }
        const data: Prisma.PricingRuleUpdateInput = {}
        if (body.name !== undefined) data.name = body.name
        if (body.type !== undefined) {
          if (!VALID_TYPES.has(body.type)) {
            return reply.code(400).send({
              error: `type must be one of ${[...VALID_TYPES].join(', ')}`,
            })
          }
          data.type = body.type
        }
        if (body.description !== undefined) data.description = body.description
        if (body.priority !== undefined && Number.isFinite(body.priority)) {
          data.priority = Number(body.priority)
        }
        if (body.minMarginPercent !== undefined) {
          data.minMarginPercent =
            body.minMarginPercent == null
              ? null
              : new Prisma.Decimal(body.minMarginPercent)
        }
        if (body.maxMarginPercent !== undefined) {
          data.maxMarginPercent =
            body.maxMarginPercent == null
              ? null
              : new Prisma.Decimal(body.maxMarginPercent)
        }
        if (body.parameters !== undefined) {
          data.parameters = body.parameters as Prisma.InputJsonValue
        }
        if (body.isActive !== undefined) data.isActive = body.isActive
        const rule = await prisma.pricingRule.update({
          where: { id: request.params.id },
          data,
        })
        return rule
      } catch (error: any) {
        if (error?.code === 'P2025') {
          return reply.code(404).send({ error: 'rule not found' })
        }
        fastify.log.error({ err: error }, '[pricing-rules PUT] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/pricing-rules/:id',
    async (request, reply) => {
      try {
        // Soft delete: flip isActive=false. Preserves the audit trail (the
        // engine's PRICING_RULE source path filters by isActive=true so a
        // deactivated rule has no functional effect, just an archive entry).
        const rule = await prisma.pricingRule.update({
          where: { id: request.params.id },
          data: { isActive: false },
        })
        return rule
      } catch (error: any) {
        if (error?.code === 'P2025') {
          return reply.code(404).send({ error: 'rule not found' })
        }
        fastify.log.error({ err: error }, '[pricing-rules DELETE] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )
}

export default pricingRulesRoutes
