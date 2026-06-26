/**
 * VP.3 — eBay Volume Pricing API.
 *
 * CRUD + push + preview for the EbayVolumePromotion table (schema.prisma:11369).
 * Mirrors the structure of the other eBay routes (default-export Fastify plugin,
 * registered under /api). Tier validation runs at every write boundary via the
 * VP.1 pure validateVolumeTiers so a malformed ladder never reaches the DB.
 *
 *   POST   /api/ebay/volume-promotions          — create a draft promotion.
 *   GET    /api/ebay/volume-promotions          — list (?marketplace, ?status).
 *   GET    /api/ebay/volume-promotions/:id       — read one.
 *   PATCH  /api/ebay/volume-promotions/:id       — update name/tiers/skus/dates/status.
 *   DELETE /api/ebay/volume-promotions/:id       — delete one.
 *   POST   /api/ebay/volume-promotions/:id/push  — push to eBay (VP.2; dry-run
 *            unless NEXUS_EBAY_VOLUME_LIVE=1).
 *   POST   /api/ebay/volume-promotions/preview   — validate + compute tiers
 *            against a base price (no DB write).
 *
 * VP.3 adds reusable tier templates + rule-based SKU assignment:
 *   POST   /api/ebay/volume-tier-templates       — create a named tier ladder.
 *   GET    /api/ebay/volume-tier-templates       — list templates.
 *   GET    /api/ebay/volume-tier-templates/:id    — read one.
 *   PATCH  /api/ebay/volume-tier-templates/:id    — update name/description/tiers.
 *   DELETE /api/ebay/volume-tier-templates/:id    — delete one.
 *   POST   /api/ebay/volume-promotions/from-template — copy a template's tiers
 *            into a new DRAFT promotion (COPY semantics — no FK).
 *   POST   /api/ebay/volume-promotions/resolve-skus  — resolve a marketplace +
 *            category/brand/price/margin rule into the eligible SKU list.
 */

import type { FastifyInstance } from 'fastify'
import { Prisma } from '@nexus/database'
import prisma from '../db.js'
import {
  validateVolumeTiers,
  computeTiers,
  type VolumeTier,
} from '../services/ebay-volume-pricing.service.js'
import { pushVolumePromotion } from '../services/ebay-volume-pricing-push.service.js'
import {
  resolveSkusByRule,
  type ResolveSkusRule,
} from '../services/ebay-volume-pricing-resolve.service.js'

export default async function ebayVolumePricingRoutes(fastify: FastifyInstance) {
  // ── POST /api/ebay/volume-promotions ────────────────────────────────
  // Create a draft volume promotion. Tiers are validated up front so an
  // invalid ladder is rejected before it lands as a DRAFT row.
  fastify.post<{
    Body: {
      name?: string
      marketplace?: string
      tiers?: VolumeTier[]
      skus?: string[]
      startDate?: string
      endDate?: string
    }
  }>('/ebay/volume-promotions', async (request, reply) => {
    const { name, marketplace, tiers, skus, startDate, endDate } = request.body ?? {}

    if (!name || !marketplace) {
      return reply.code(400).send({ error: 'name and marketplace are required' })
    }
    if (!Array.isArray(tiers)) {
      return reply.code(400).send({ error: 'tiers is required' })
    }
    const validation = validateVolumeTiers(tiers)
    if (!validation.ok) {
      return reply.code(400).send({ error: 'invalid tiers', validation })
    }

    const promo = await prisma.ebayVolumePromotion.create({
      data: {
        name,
        marketplace,
        tiers: tiers as unknown as Prisma.InputJsonValue,
        skus: Array.isArray(skus) ? (skus as unknown as Prisma.InputJsonValue) : undefined,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        status: 'DRAFT',
      },
    })
    return reply.code(201).send({ promotion: promo, warnings: validation.warnings })
  })

  // ── GET /api/ebay/volume-promotions ─────────────────────────────────
  // List promotions, newest first. Optional ?marketplace + ?status filters.
  fastify.get<{
    Querystring: { marketplace?: string; status?: string }
  }>('/ebay/volume-promotions', async (request, reply) => {
    const { marketplace, status } = request.query
    const promotions = await prisma.ebayVolumePromotion.findMany({
      where: {
        ...(marketplace ? { marketplace } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    })
    return reply.send({ promotions })
  })

  // ── GET /api/ebay/volume-promotions/:id ─────────────────────────────
  fastify.get<{
    Params: { id: string }
  }>('/ebay/volume-promotions/:id', async (request, reply) => {
    const promo = await prisma.ebayVolumePromotion.findUnique({
      where: { id: request.params.id },
    })
    if (!promo) {
      return reply.code(404).send({ error: 'volume promotion not found' })
    }
    return reply.send({ promotion: promo })
  })

  // ── PATCH /api/ebay/volume-promotions/:id ───────────────────────────
  // Update name / tiers / skus / dates / status. Tiers are re-validated
  // whenever supplied so an edit can't sneak a malformed ladder through.
  fastify.patch<{
    Params: { id: string }
    Body: {
      name?: string
      tiers?: VolumeTier[]
      skus?: string[]
      startDate?: string | null
      endDate?: string | null
      status?: string
    }
  }>('/ebay/volume-promotions/:id', async (request, reply) => {
    const { id } = request.params
    const { name, tiers, skus, startDate, endDate, status } = request.body ?? {}

    const existing = await prisma.ebayVolumePromotion.findUnique({ where: { id } })
    if (!existing) {
      return reply.code(404).send({ error: 'volume promotion not found' })
    }

    let warnings: string[] = []
    if (tiers !== undefined) {
      if (!Array.isArray(tiers)) {
        return reply.code(400).send({ error: 'tiers must be an array' })
      }
      const validation = validateVolumeTiers(tiers)
      if (!validation.ok) {
        return reply.code(400).send({ error: 'invalid tiers', validation })
      }
      warnings = validation.warnings
    }

    const promo = await prisma.ebayVolumePromotion.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(tiers !== undefined ? { tiers: tiers as unknown as Prisma.InputJsonValue } : {}),
        ...(skus !== undefined
          ? { skus: Array.isArray(skus) ? (skus as unknown as Prisma.InputJsonValue) : Prisma.JsonNull }
          : {}),
        ...(startDate !== undefined ? { startDate: startDate ? new Date(startDate) : null } : {}),
        ...(endDate !== undefined ? { endDate: endDate ? new Date(endDate) : null } : {}),
        ...(status !== undefined ? { status } : {}),
      },
    })
    return reply.send({ promotion: promo, warnings })
  })

  // ── DELETE /api/ebay/volume-promotions/:id ──────────────────────────
  fastify.delete<{
    Params: { id: string }
  }>('/ebay/volume-promotions/:id', async (request, reply) => {
    const existing = await prisma.ebayVolumePromotion.findUnique({
      where: { id: request.params.id },
    })
    if (!existing) {
      return reply.code(404).send({ error: 'volume promotion not found' })
    }
    await prisma.ebayVolumePromotion.delete({ where: { id: request.params.id } })
    return reply.send({ ok: true })
  })

  // ── POST /api/ebay/volume-promotions/:id/push ───────────────────────
  // Push to eBay via the VP.2 publisher. Dry-run unless NEXUS_EBAY_VOLUME_LIVE=1.
  fastify.post<{
    Params: { id: string }
  }>('/ebay/volume-promotions/:id/push', async (request, reply) => {
    const result = await pushVolumePromotion(prisma, request.params.id)
    if (!result.ok) {
      const code = result.error === 'volume promotion not found' ? 404 : 400
      return reply.code(code).send(result)
    }
    return reply.send(result)
  })

  // ── POST /api/ebay/volume-promotions/preview ────────────────────────
  // Validate a tier ladder and compute the buyer-facing price + margin at
  // each tier against a base price (and optional cost). No DB write — backs
  // the live simulator in the UI.
  fastify.post<{
    Body: {
      tiers?: VolumeTier[]
      basePrice?: number
      cost?: number | null
    }
  }>('/ebay/volume-promotions/preview', async (request, reply) => {
    const { tiers, basePrice, cost } = request.body ?? {}
    if (!Array.isArray(tiers)) {
      return reply.code(400).send({ error: 'tiers is required' })
    }
    if (typeof basePrice !== 'number' || !(basePrice > 0)) {
      return reply.code(400).send({ error: 'basePrice must be a positive number' })
    }
    return reply.send({
      validation: validateVolumeTiers(tiers),
      computed: computeTiers(tiers, basePrice, cost),
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // VP.3 — reusable tier templates (a library of named tier ladders).
  // Apply semantics are COPY: a promotion built from a template copies the
  // tiers in (see /from-template); there is no FK back to the template.
  // ════════════════════════════════════════════════════════════════════

  // ── POST /api/ebay/volume-tier-templates ────────────────────────────
  // Create a named tier ladder. Tiers are validated with the same VP.1
  // rules as a promotion, so a template can never hold a malformed ladder.
  fastify.post<{
    Body: { name?: string; description?: string | null; tiers?: VolumeTier[] }
  }>('/ebay/volume-tier-templates', async (request, reply) => {
    const { name, description, tiers } = request.body ?? {}
    if (!name) {
      return reply.code(400).send({ error: 'name is required' })
    }
    if (!Array.isArray(tiers)) {
      return reply.code(400).send({ error: 'tiers is required' })
    }
    const validation = validateVolumeTiers(tiers)
    if (!validation.ok) {
      return reply.code(400).send({ error: 'invalid tiers', validation })
    }
    const template = await prisma.ebayVolumeTierTemplate.create({
      data: {
        name,
        description: description ?? null,
        tiers: tiers as unknown as Prisma.InputJsonValue,
      },
    })
    return reply.code(201).send({ template, warnings: validation.warnings })
  })

  // ── GET /api/ebay/volume-tier-templates ─────────────────────────────
  fastify.get('/ebay/volume-tier-templates', async (_request, reply) => {
    const templates = await prisma.ebayVolumeTierTemplate.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return reply.send({ templates })
  })

  // ── GET /api/ebay/volume-tier-templates/:id ─────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/ebay/volume-tier-templates/:id',
    async (request, reply) => {
      const template = await prisma.ebayVolumeTierTemplate.findUnique({
        where: { id: request.params.id },
      })
      if (!template) {
        return reply.code(404).send({ error: 'tier template not found' })
      }
      return reply.send({ template })
    },
  )

  // ── PATCH /api/ebay/volume-tier-templates/:id ───────────────────────
  // Update name / description / tiers. Tiers are re-validated whenever supplied.
  fastify.patch<{
    Params: { id: string }
    Body: { name?: string; description?: string | null; tiers?: VolumeTier[] }
  }>('/ebay/volume-tier-templates/:id', async (request, reply) => {
    const { id } = request.params
    const { name, description, tiers } = request.body ?? {}

    const existing = await prisma.ebayVolumeTierTemplate.findUnique({ where: { id } })
    if (!existing) {
      return reply.code(404).send({ error: 'tier template not found' })
    }

    let warnings: string[] = []
    if (tiers !== undefined) {
      if (!Array.isArray(tiers)) {
        return reply.code(400).send({ error: 'tiers must be an array' })
      }
      const validation = validateVolumeTiers(tiers)
      if (!validation.ok) {
        return reply.code(400).send({ error: 'invalid tiers', validation })
      }
      warnings = validation.warnings
    }

    const template = await prisma.ebayVolumeTierTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tiers !== undefined ? { tiers: tiers as unknown as Prisma.InputJsonValue } : {}),
      },
    })
    return reply.send({ template, warnings })
  })

  // ── DELETE /api/ebay/volume-tier-templates/:id ──────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/ebay/volume-tier-templates/:id',
    async (request, reply) => {
      const existing = await prisma.ebayVolumeTierTemplate.findUnique({
        where: { id: request.params.id },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'tier template not found' })
      }
      await prisma.ebayVolumeTierTemplate.delete({ where: { id: request.params.id } })
      return reply.send({ ok: true })
    },
  )

  // ── POST /api/ebay/volume-promotions/from-template ──────────────────
  // Copy a template's tiers into a brand-new DRAFT promotion (COPY semantics —
  // the promotion and template share no row, so they diverge freely after).
  // The copied tiers are re-validated in case the template predates a rule change.
  fastify.post<{
    Body: {
      templateId?: string
      name?: string
      marketplace?: string
      skus?: string[]
      startDate?: string
      endDate?: string
    }
  }>('/ebay/volume-promotions/from-template', async (request, reply) => {
    const { templateId, name, marketplace, skus, startDate, endDate } = request.body ?? {}
    if (!templateId) {
      return reply.code(400).send({ error: 'templateId is required' })
    }
    if (!name || !marketplace) {
      return reply.code(400).send({ error: 'name and marketplace are required' })
    }

    const template = await prisma.ebayVolumeTierTemplate.findUnique({ where: { id: templateId } })
    if (!template) {
      return reply.code(404).send({ error: 'tier template not found' })
    }

    const tiers = (Array.isArray(template.tiers) ? template.tiers : []) as unknown as VolumeTier[]
    const validation = validateVolumeTiers(tiers)
    if (!validation.ok) {
      return reply.code(400).send({ error: 'template has invalid tiers', validation })
    }

    const promo = await prisma.ebayVolumePromotion.create({
      data: {
        name,
        marketplace,
        tiers: tiers as unknown as Prisma.InputJsonValue,
        skus: Array.isArray(skus) ? (skus as unknown as Prisma.InputJsonValue) : undefined,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        status: 'DRAFT',
      },
    })
    return reply.code(201).send({ promotion: promo, warnings: validation.warnings })
  })

  // ── POST /api/ebay/volume-promotions/resolve-skus ───────────────────
  // Resolve a rule (marketplace + optional category subtree / brand / maxPrice /
  // minMarginPercent) into the eligible SKU list to drop into a promotion's
  // `skus`. Read-only — no DB write. Caps at the eBay 500-SKU limit and reports
  // truncation. See resolveSkusByRule for the eligibility model + cost source.
  fastify.post<{ Body: Partial<ResolveSkusRule> }>(
    '/ebay/volume-promotions/resolve-skus',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.marketplace) {
        return reply.code(400).send({ error: 'marketplace is required' })
      }
      const result = await resolveSkusByRule(prisma, {
        marketplace: body.marketplace,
        categoryId: body.categoryId,
        brand: body.brand,
        minMarginPercent: body.minMarginPercent,
        maxPrice: body.maxPrice,
        limit: body.limit,
      })
      return reply.send(result)
    },
  )
}
