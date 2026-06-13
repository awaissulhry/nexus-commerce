/**
 * FM.11 — Amazon cockpit parity: back-write (promote-to-master) +
 * apply-to-siblings (template-apply + candidates), mirroring the eBay
 * cockpit (EC.14/EC.15). Closes the asymmetry where eBay could promote a
 * cockpit edit up to master + copy a layout across siblings but Amazon
 * couldn't.
 *
 * Separate file from amazon-cockpit-publish.routes.ts and the untouchable
 * amazon-flat-file routes; touches only Product + ChannelListing. Mounted
 * under /api → /api/amazon/cockpit/*.
 */

import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { casUpdateChannelListing } from '../services/channel-listing-cas.js'

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

  // ── POST /api/amazon/cockpit/template-apply ─────────────────────────
  // Copy the donor's Amazon layout (scope-filtered) onto each target, with
  // a per-target pre-apply snapshot in _versionHistory (reason=
  // "pre-template-apply") for one-click undo. Scope flags:
  //   attributes — the JSON_LISTINGS_FEED attribute map (default ON)
  //   condition  — condition_type (default ON)
  //   category   — productType + browseNodeId (OFF by default — risky if
  //                siblings differ in product type)
  fastify.post<{
    Body: {
      donorProductId: string
      marketplace: string
      targetProductIds: string[]
      scope?: { attributes?: boolean; condition?: boolean; category?: boolean }
    }
  }>('/amazon/cockpit/template-apply', async (request, reply) => {
    const body = request.body
    if (!body) return reply.code(400).send({ error: 'Body is required' })
    const { donorProductId, marketplace, targetProductIds, scope = {} } = body
    if (!donorProductId || !marketplace) {
      return reply.code(400).send({ error: 'donorProductId, marketplace are required' })
    }
    if (!Array.isArray(targetProductIds) || targetProductIds.length === 0) {
      return reply.code(400).send({ error: 'targetProductIds must be a non-empty array' })
    }
    if (targetProductIds.length > 200) {
      return reply.code(400).send({ error: 'Max 200 targets per call' })
    }
    const flags = {
      attributes: scope.attributes !== false,
      condition: scope.condition !== false,
      category: scope.category === true, // opt-IN
    }

    const donor = await prisma.channelListing.findFirst({
      where: { productId: donorProductId, channel: 'AMAZON', marketplace },
    })
    if (!donor) {
      return reply.code(404).send({ error: 'Donor has no Amazon listing for this marketplace' })
    }
    const donorPlatform = (donor.platformAttributes ?? {}) as Record<string, unknown>

    const layout: Record<string, unknown> = {}
    if (flags.attributes && donorPlatform.attributes !== undefined) {
      layout.attributes = donorPlatform.attributes
    }
    if (flags.condition && donorPlatform.condition_type !== undefined) {
      layout.condition_type = donorPlatform.condition_type
    }
    if (flags.category) {
      for (const k of ['productType', 'browseNodeId']) {
        if (donorPlatform[k] !== undefined) layout[k] = donorPlatform[k]
      }
    }

    if (Object.keys(layout).length === 0) {
      return reply.code(400).send({ error: 'Nothing to copy — every scope flag is off or donor has no data.' })
    }

    const results: Array<{ productId: string; ok: boolean; snapshotId?: string; error?: string }> = []

    for (const targetId of targetProductIds) {
      try {
        if (targetId === donorProductId) {
          results.push({ productId: targetId, ok: false, error: 'Cannot apply to donor itself' })
          continue
        }
        const target = await prisma.channelListing.findFirst({
          where: { productId: targetId, channel: 'AMAZON', marketplace },
        })

        const isCreate = !target
        const prevPlatform = (target?.platformAttributes ?? {}) as Record<string, unknown>
        const { _versionHistory: prevHistRaw, ...snapshotPlatform } = prevPlatform
        const prevHistory = Array.isArray(prevHistRaw) ? (prevHistRaw as unknown[]) : []
        const snapshotEntry = {
          id: `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          ts: new Date().toISOString(),
          reason: 'pre-template-apply',
          snapshot: {
            platformAttributes: snapshotPlatform,
            priceOverride: target?.priceOverride != null ? Number(target.priceOverride) : null,
            quantity: target?.quantity ?? null,
          },
        }
        const nextHistory = [snapshotEntry, ...prevHistory].slice(0, 10)
        const nextPlatform: Record<string, unknown> = {
          ...prevPlatform,
          ...layout,
          _versionHistory: nextHistory,
        }
        if (isCreate) {
          await prisma.channelListing.create({
            data: {
              productId: targetId,
              channel: 'AMAZON',
              region: marketplace.toUpperCase(),
              marketplace,
              channelMarket: `AMAZON_${marketplace.toUpperCase()}`,
              listingStatus: 'DRAFT',
              isPublished: false,
              platformAttributes: nextPlatform as Prisma.InputJsonValue,
            },
          })
        } else {
          // A3 — bump version (no CAS: this is a deliberate bulk apply) so the
          // flat-file editor detects the change and won't silently clobber it.
          await casUpdateChannelListing(prisma, target!.id, undefined, {
            platformAttributes: nextPlatform as Prisma.InputJsonValue,
          })
        }
        results.push({ productId: targetId, ok: true, snapshotId: snapshotEntry.id })
      } catch (err) {
        results.push({
          productId: targetId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return reply.send({
      donorProductId,
      marketplace,
      scope: flags,
      layerKeys: Object.keys(layout),
      results,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
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
