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

  // D.2 — Dry-run simulator. Caller passes a rule definition (no DB write)
  // + an optional scope (productIds / variationIds). Returns the projected
  // price delta against the current PricingSnapshot for each in-scope row.
  // Mirrors the math at pricing-engine.service.ts:326-384 + the margin-floor
  // clamp at line 425-437 so previews match the engine's actual behaviour.
  //
  // No scope ⇒ sample of the first 100 snapshot rows (gives the operator
  // a "what would this look like across the catalog" gut check).
  fastify.post('/pricing-rules/simulate', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        type?: string
        parameters?: Record<string, unknown>
        minMarginPercent?: number | null
        productIds?: string[]
        variationIds?: string[]
        limit?: number
      }
      if (!body.type || !VALID_TYPES.has(body.type)) {
        return reply.code(400).send({
          error: `type must be one of ${[...VALID_TYPES].join(', ')}`,
        })
      }
      const params = body.parameters ?? {}
      const minMargin =
        body.minMarginPercent != null ? Number(body.minMarginPercent) : null

      // Resolve the SKU set we'll preview against.
      let snapshotWhere: Prisma.PricingSnapshotWhereInput | undefined
      if (body.variationIds?.length) {
        const variants = await prisma.productVariation.findMany({
          where: { id: { in: body.variationIds } },
          select: { sku: true },
        })
        snapshotWhere = { sku: { in: variants.map((v) => v.sku) } }
      } else if (body.productIds?.length) {
        const variants = await prisma.productVariation.findMany({
          where: { productId: { in: body.productIds } },
          select: { sku: true },
        })
        const products = await prisma.product.findMany({
          where: { id: { in: body.productIds } },
          select: { sku: true },
        })
        const skus = [
          ...new Set([
            ...variants.map((v) => v.sku),
            ...products.map((p) => p.sku),
          ]),
        ]
        snapshotWhere = { sku: { in: skus } }
      }

      const limit = Math.min(500, Math.max(1, body.limit ?? 100))
      const snapshots = await prisma.pricingSnapshot.findMany({
        where: snapshotWhere,
        orderBy: [{ sku: 'asc' }, { channel: 'asc' }, { marketplace: 'asc' }],
        take: limit,
      })

      const rows = snapshots.map((snap) => {
        const b = (snap.breakdown ?? {}) as {
          effectiveCostBasis?: number | null
          costPrice?: number | null
          fxRate?: number
          fbaFee?: number
          referralFee?: number
          taxInclusive?: boolean
          vatRate?: number
        }
        const costBasis = b.effectiveCostBasis ?? b.costPrice ?? null
        const fxRate = b.fxRate ?? 1
        const competitorPriceMp = null as number | null // breakdown doesn't carry it; competitor rules need ChannelListing
        let projected: number | null = null
        let reason = ''

        switch (body.type) {
          case 'COST_PLUS_MARGIN': {
            const marginPercent = Number(params.marginPercent)
            if (Number.isFinite(marginPercent) && costBasis != null) {
              projected = costBasis * (1 + marginPercent / 100) * fxRate
              reason = `cost ${costBasis.toFixed(2)} × (1 + ${marginPercent}%) × fx ${fxRate.toFixed(4)}`
            } else {
              reason = costBasis == null ? 'no cost basis' : 'invalid marginPercent'
            }
            break
          }
          case 'DYNAMIC_MARGIN': {
            const targetMargin = Number(params.targetMargin ?? params.baseMargin)
            if (Number.isFinite(targetMargin) && costBasis != null) {
              projected = costBasis * (1 + targetMargin / 100) * fxRate
              reason = `cost ${costBasis.toFixed(2)} × (1 + ${targetMargin}%) × fx ${fxRate.toFixed(4)}`
            } else {
              reason = costBasis == null ? 'no cost basis' : 'invalid targetMargin'
            }
            break
          }
          case 'FIXED_PRICE': {
            const fixed = Number(params.fixedPrice)
            if (Number.isFinite(fixed) && fixed > 0) {
              projected = fixed
              reason = `fixed ${fixed.toFixed(2)} ${snap.currency}`
            } else {
              reason = 'invalid fixedPrice'
            }
            break
          }
          case 'MATCH_LOW':
          case 'PERCENTAGE_BELOW': {
            // Both rules need lowestCompetitorPrice from ChannelListing; the
            // breakdown JSON doesn't carry it, so per-row preview would
            // require an extra join. For simulator scope, surface this as
            // "needs competitor data" — the engine still applies the rule
            // at materialization time when the competitor cron has populated
            // ChannelListing.lowestCompetitorPrice.
            reason = 'rule needs competitor price (live at materialize time)'
            break
          }
        }

        // Apply margin floor if both minMargin and costBasis are present.
        let wouldClamp = false
        if (
          projected != null &&
          minMargin != null &&
          costBasis != null &&
          costBasis > 0
        ) {
          // Margin against the projected price (in master currency, before
          // tax-inclusive markup since clamp is on net economics).
          const projectedNet = b.taxInclusive
            ? projected / (1 + (b.vatRate ?? 0) / 100)
            : projected
          const projectedNetInMaster = projectedNet / fxRate
          const margin =
            ((projectedNetInMaster - costBasis) / projectedNetInMaster) * 100
          if (margin < minMargin) {
            const floor = costBasis * (1 + minMargin / 100) * fxRate
            wouldClamp = true
            reason += ` → clamped to margin floor ${floor.toFixed(2)} (would be ${margin.toFixed(1)}%)`
            projected = floor
          }
        }

        const current = Number(snap.computedPrice)
        const delta = projected != null ? projected - current : null
        return {
          sku: snap.sku,
          channel: snap.channel,
          marketplace: snap.marketplace,
          fulfillmentMethod: snap.fulfillmentMethod,
          currency: snap.currency,
          currentPrice: current,
          currentSource: snap.source,
          projectedPrice: projected != null ? Math.round(projected * 100) / 100 : null,
          delta: delta != null ? Math.round(delta * 100) / 100 : null,
          wouldClamp,
          reason,
        }
      })

      // Summary stats so the UI can render headline numbers without
      // re-aggregating client-side.
      const evaluable = rows.filter((r) => r.projectedPrice != null)
      const avgDelta =
        evaluable.length > 0
          ? evaluable.reduce((sum, r) => sum + (r.delta ?? 0), 0) /
            evaluable.length
          : 0
      const summary = {
        scoped: rows.length,
        evaluated: evaluable.length,
        wouldClamp: rows.filter((r) => r.wouldClamp).length,
        priceUp: evaluable.filter((r) => (r.delta ?? 0) > 0).length,
        priceDown: evaluable.filter((r) => (r.delta ?? 0) < 0).length,
        avgDelta: Math.round(avgDelta * 100) / 100,
      }

      return { summary, rows }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing-rules/simulate] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })
}

export default pricingRulesRoutes
