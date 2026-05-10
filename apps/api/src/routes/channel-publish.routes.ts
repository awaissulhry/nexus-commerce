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
  channelPublishMode,
  type ChannelKey,
  type PublishResult,
} from '../services/channel-publish.service.js'

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
}

export default channelPublishRoutes
