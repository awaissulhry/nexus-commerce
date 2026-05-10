/**
 * MC.12 — Channel image publish dispatch.
 *
 * One endpoint per channel for now (mirrors MC.8.9 / MC.9.4
 * submission patterns). Body shape is shared via PublishInput.
 * Each call records an AuditLog row so the operator's history
 * survives even when the underlying channel APIs come back online
 * later.
 *
 * MC.12.1 ships Amazon. MC.12.2/3/4 add eBay/Shopify/Woo branches
 * to the same channel-publish.service.ts.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  publishToAmazon,
  publishToEbay,
  publishToShopify,
  publishToWoo,
  channelPublishMode,
  type ChannelKey,
  type PublishResult,
} from '../services/channel-publish.service.js'
import { enqueueCascadeRepublish } from '../services/cascade-image-republish.service.js'

const channelPublishRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Mode introspection ──────────────────────────────────────

  fastify.get('/channel-publish/_meta/mode', async () => {
    const channels: ChannelKey[] = [
      'AMAZON',
      'EBAY',
      'SHOPIFY',
      'WOOCOMMERCE',
    ]
    const modes = Object.fromEntries(
      channels.map((c) => [c, channelPublishMode(c)]),
    )
    return { modes }
  })

  // ── Amazon — MC.12.1 ─────────────────────────────────────────

  fastify.post('/channel-publish/amazon', async (request, reply) => {
    const body = request.body as {
      assetId?: string
      assetUrl?: string
      asin?: string
      productId?: string
      imageType?: string
    }
    if (!body.asin?.trim())
      return reply.code(400).send({ error: 'asin is required' })

    // The operator can pass either an asset id (we look up the URL)
    // or an asset URL directly (handy for ad-hoc publishes from
    // outside the DAM).
    let assetUrl = body.assetUrl?.trim() ?? null
    if (!assetUrl && body.assetId) {
      const id = body.assetId
      if (id.startsWith('da_')) {
        const asset = await prisma.digitalAsset.findUnique({
          where: { id: id.slice(3) },
          select: { url: true },
        })
        assetUrl = asset?.url ?? null
      } else if (id.startsWith('pi_')) {
        const row = await prisma.productImage.findUnique({
          where: { id: id.slice(3) },
          select: { url: true },
        })
        assetUrl = row?.url ?? null
      } else {
        return reply.code(400).send({
          error:
            'assetId must be prefixed "da_" (digital asset) or "pi_" (product image)',
        })
      }
    }
    if (!assetUrl)
      return reply.code(400).send({ error: 'asset not found' })

    const result: PublishResult = await publishToAmazon({
      assetUrl,
      destinationId: body.asin,
      options: { imageType: body.imageType ?? 'MAIN' },
    })

    // Audit row. Use AuditLog for "what was attempted, when, by whom"
    // — no separate publish-history model in this commit (MC.12-
    // followup promotes to ChannelImagePublish if the operator
    // wants per-asset publish state queries).
    try {
      await prisma.auditLog.create({
        data: {
          action: result.ok ? 'CHANNEL_PUBLISH_OK' : 'CHANNEL_PUBLISH_FAILED',
          entityType: 'DigitalAsset',
          entityId: body.assetId ?? assetUrl,
          metadata: {
            channel: 'AMAZON',
            mode: result.mode,
            asin: body.asin,
            productId: body.productId ?? null,
            channelImageId: result.channelImageId,
            error: result.error,
            response: result.rawResponse,
          } as never,
        },
      })
    } catch (err) {
      // Non-blocking — audit failure shouldn't break the publish
      // result returned to the operator.
      request.log.warn(
        { err, assetId: body.assetId },
        'Failed to write AuditLog row for Amazon publish',
      )
    }

    return reply.code(result.ok ? 200 : 502).send(result)
  })

  // ── eBay — MC.12.2 ────────────────────────────────────────────

  fastify.post('/channel-publish/ebay', async (request, reply) => {
    const body = request.body as {
      assetId?: string
      assetUrl?: string
      itemId?: string
      productId?: string
      gallerySlot?: string
    }
    if (!body.itemId?.trim())
      return reply.code(400).send({ error: 'itemId is required' })

    let assetUrl = body.assetUrl?.trim() ?? null
    if (!assetUrl && body.assetId) {
      const id = body.assetId
      if (id.startsWith('da_')) {
        const asset = await prisma.digitalAsset.findUnique({
          where: { id: id.slice(3) },
          select: { url: true },
        })
        assetUrl = asset?.url ?? null
      } else if (id.startsWith('pi_')) {
        const row = await prisma.productImage.findUnique({
          where: { id: id.slice(3) },
          select: { url: true },
        })
        assetUrl = row?.url ?? null
      } else {
        return reply.code(400).send({
          error:
            'assetId must be prefixed "da_" (digital asset) or "pi_" (product image)',
        })
      }
    }
    if (!assetUrl)
      return reply.code(400).send({ error: 'asset not found' })

    const result: PublishResult = await publishToEbay({
      assetUrl,
      destinationId: body.itemId,
      options: { gallerySlot: body.gallerySlot ?? '0' },
    })

    try {
      await prisma.auditLog.create({
        data: {
          action: result.ok ? 'CHANNEL_PUBLISH_OK' : 'CHANNEL_PUBLISH_FAILED',
          entityType: 'DigitalAsset',
          entityId: body.assetId ?? assetUrl,
          metadata: {
            channel: 'EBAY',
            mode: result.mode,
            itemId: body.itemId,
            productId: body.productId ?? null,
            channelImageId: result.channelImageId,
            error: result.error,
            response: result.rawResponse,
          } as never,
        },
      })
    } catch (err) {
      request.log.warn(
        { err, assetId: body.assetId },
        'Failed to write AuditLog row for eBay publish',
      )
    }
    return reply.code(result.ok ? 200 : 502).send(result)
  })

  // ── Shopify — MC.12.3 ─────────────────────────────────────────

  fastify.post('/channel-publish/shopify', async (request, reply) => {
    const body = request.body as {
      assetId?: string
      assetUrl?: string
      productGid?: string
      productId?: string
    }
    if (!body.productGid?.trim())
      return reply.code(400).send({ error: 'productGid is required' })

    let assetUrl = body.assetUrl?.trim() ?? null
    if (!assetUrl && body.assetId) {
      const id = body.assetId
      if (id.startsWith('da_')) {
        const asset = await prisma.digitalAsset.findUnique({
          where: { id: id.slice(3) },
          select: { url: true },
        })
        assetUrl = asset?.url ?? null
      } else if (id.startsWith('pi_')) {
        const row = await prisma.productImage.findUnique({
          where: { id: id.slice(3) },
          select: { url: true },
        })
        assetUrl = row?.url ?? null
      } else {
        return reply.code(400).send({
          error:
            'assetId must be prefixed "da_" (digital asset) or "pi_" (product image)',
        })
      }
    }
    if (!assetUrl)
      return reply.code(400).send({ error: 'asset not found' })

    const result: PublishResult = await publishToShopify({
      assetUrl,
      destinationId: body.productGid,
    })

    try {
      await prisma.auditLog.create({
        data: {
          action: result.ok ? 'CHANNEL_PUBLISH_OK' : 'CHANNEL_PUBLISH_FAILED',
          entityType: 'DigitalAsset',
          entityId: body.assetId ?? assetUrl,
          metadata: {
            channel: 'SHOPIFY',
            mode: result.mode,
            productGid: body.productGid,
            productId: body.productId ?? null,
            channelImageId: result.channelImageId,
            error: result.error,
            response: result.rawResponse,
          } as never,
        },
      })
    } catch (err) {
      request.log.warn(
        { err, assetId: body.assetId },
        'Failed to write AuditLog row for Shopify publish',
      )
    }
    return reply.code(result.ok ? 200 : 502).send(result)
  })

  // ── WooCommerce — MC.12.4 ─────────────────────────────────────

  fastify.post('/channel-publish/woo', async (request, reply) => {
    const body = request.body as {
      assetId?: string
      assetUrl?: string
      productId?: string
      wooProductId?: string
    }
    if (!body.wooProductId?.trim())
      return reply.code(400).send({ error: 'wooProductId is required' })

    let assetUrl = body.assetUrl?.trim() ?? null
    if (!assetUrl && body.assetId) {
      const id = body.assetId
      if (id.startsWith('da_')) {
        const asset = await prisma.digitalAsset.findUnique({
          where: { id: id.slice(3) },
          select: { url: true },
        })
        assetUrl = asset?.url ?? null
      } else if (id.startsWith('pi_')) {
        const row = await prisma.productImage.findUnique({
          where: { id: id.slice(3) },
          select: { url: true },
        })
        assetUrl = row?.url ?? null
      } else {
        return reply.code(400).send({
          error:
            'assetId must be prefixed "da_" (digital asset) or "pi_" (product image)',
        })
      }
    }
    if (!assetUrl)
      return reply.code(400).send({ error: 'asset not found' })

    const result: PublishResult = await publishToWoo({
      assetUrl,
      destinationId: body.wooProductId,
    })

    try {
      await prisma.auditLog.create({
        data: {
          action: result.ok ? 'CHANNEL_PUBLISH_OK' : 'CHANNEL_PUBLISH_FAILED',
          entityType: 'DigitalAsset',
          entityId: body.assetId ?? assetUrl,
          metadata: {
            channel: 'WOOCOMMERCE',
            mode: result.mode,
            wooProductId: body.wooProductId,
            productId: body.productId ?? null,
            channelImageId: result.channelImageId,
            error: result.error,
            response: result.rawResponse,
          } as never,
        },
      })
    } catch (err) {
      request.log.warn(
        { err, assetId: body.assetId },
        'Failed to write AuditLog row for Woo publish',
      )
    }
    return reply.code(result.ok ? 200 : 502).send(result)
  })

  // ── Cascade fan-out — MC.12.6 ──────────────────────────────────

  fastify.post('/channel-publish/cascade', async (request, reply) => {
    const body = request.body as {
      productId?: string
      assetUrl?: string
      assetId?: string
      channels?: Array<'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'>
    }
    if (!body.productId?.trim())
      return reply.code(400).send({ error: 'productId is required' })
    if (!body.assetUrl?.trim())
      return reply.code(400).send({ error: 'assetUrl is required' })

    try {
      const result = await enqueueCascadeRepublish({
        productId: body.productId,
        assetUrl: body.assetUrl,
        assetId: body.assetId,
        channels: body.channels,
      })
      return reply.code(200).send({ result })
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found'))
        return reply.code(404).send({ error: err.message })
      throw err
    }
  })
}

export default channelPublishRoutes
