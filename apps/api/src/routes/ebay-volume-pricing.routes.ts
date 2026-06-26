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
}
