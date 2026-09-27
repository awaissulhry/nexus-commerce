/**
 * FM.11 — Amazon cockpit parity: back-write (promote-to-master) +
 * apply-to-siblings candidates, mirroring the eBay cockpit (EC.14/EC.15).
 * The template-apply writer (which created a missing target listing as a
 * DRAFT) was deleted in step 7, part 3: only the unmounted old product
 * editor called it.
 *
 * Separate file from amazon-cockpit-publish.routes.ts and the untouchable
 * amazon-flat-file routes; touches only Product + ChannelListing. Mounted
 * under /api → /api/amazon/cockpit/*.
 */

import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'

const amazonCockpitRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /api/amazon/cockpit/template-candidates ─────────────────────
  // Same-productType products (excluding donor + donor's children) with
  // their current Amazon listing snapshot, for the Apply-to-Siblings diff.
  fastify.get<{
    Querystring: { productId: string; marketplace: string; limit?: string }
  }>('/amazon/cockpit/template-candidates', async (request, reply) => {
    const { productId, marketplace } = request.query
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200)
    if (!productId || !marketplace) {
      return reply.code(400).send({ error: 'productId, marketplace are required' })
    }

    const donor = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, sku: true, productType: true, parentId: true },
    })
    if (!donor) return reply.code(404).send({ error: 'Donor product not found' })

    const where: Record<string, unknown> = {
      id: { not: productId },
      deletedAt: null,
      parentId: donor.parentId ?? { not: productId },
    }
    if (donor.productType) where.productType = donor.productType

    const candidates = await prisma.product.findMany({
      where,
      take: limit,
      orderBy: { sku: 'asc' },
      select: { id: true, sku: true, name: true, productType: true },
    })

    const candidateListings = await prisma.channelListing.findMany({
      where: {
        productId: { in: candidates.map((c) => c.id) },
        channel: 'AMAZON',
        marketplace,
      },
      select: { productId: true, platformAttributes: true, listingStatus: true, externalListingId: true },
    })
    const byProduct = new Map(candidateListings.map((l) => [l.productId, l]))

    return reply.send({
      donor: { id: donor.id, sku: donor.sku, productType: donor.productType },
      candidates: candidates.map((c) => {
        const l = byProduct.get(c.id)
        const p = (l?.platformAttributes ?? {}) as Record<string, unknown>
        const attributes = (p.attributes ?? {}) as Record<string, unknown>
        return {
          productId: c.id,
          sku: c.sku,
          name: c.name,
          productType: c.productType,
          hasListing: !!l,
          listingStatus: l?.listingStatus ?? null,
          externalListingId: l?.externalListingId ?? null,
          summary: {
            productType: (p.productType as string | undefined) ?? c.productType ?? null,
            attributeCount: Object.keys(attributes).length,
            conditionType: (p.condition_type as string | undefined) ?? null,
          },
        }
      }),
      total: candidates.length,
    })
  })

  // ── POST /api/amazon/cockpit/promote-to-master ──────────────────────
  // Back-write a cockpit-improved field up to the Product master. Channel-
  // agnostic (writes Product.name/description/basePrice); mirrors the eBay
  // endpoint so the Amazon MasterDivergenceBanner has a parallel target.
  fastify.post<{
    Body: {
      productId: string
      fields: { name?: string | null; description?: string | null; basePrice?: number | null }
    }
  }>('/amazon/cockpit/promote-to-master', async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { productId, fields } = body
    if (!productId || !fields || typeof fields !== 'object') {
      return reply.code(400).send({ error: 'productId, fields are required' })
    }

    const data: Record<string, unknown> = {}
    if (fields.name !== undefined) {
      const trimmed = String(fields.name ?? '').trim()
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: 'name cannot be empty when promoting' })
      }
      data.name = trimmed
    }
    if (fields.description !== undefined) {
      data.description = fields.description === null ? null : String(fields.description)
    }
    if (fields.basePrice !== undefined) {
      if (fields.basePrice === null) {
        data.basePrice = null
      } else {
        const n = Number(fields.basePrice)
        if (!Number.isFinite(n) || n < 0) {
          return reply.code(400).send({ error: 'basePrice must be a non-negative number' })
        }
        data.basePrice = new Prisma.Decimal(n)
      }
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'No supported fields supplied (name/description/basePrice).' })
    }

    try {
      const updated = await prisma.product.update({
        where: { id: productId },
        data,
        select: { id: true, sku: true, name: true, description: true, basePrice: true, updatedAt: true },
      })
      return reply.send({
        product: {
          ...updated,
          basePrice: updated.basePrice != null ? Number(updated.basePrice) : null,
        },
        promotedFields: Object.keys(data),
      })
    } catch (err) {
      request.log.error(err, '[amazon/cockpit/promote-to-master] failed')
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('Record to update not found')) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      return reply.code(500).send({ error: message })
    }
  })
}

export default amazonCockpitRoutes
