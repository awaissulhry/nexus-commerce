/**
 * PB.14 — Bulk image publish across products.
 *
 *   POST /api/products/bulk-image-publish
 *     body: { productIds: string[], channel: 'AMAZON'|'EBAY'|'SHOPIFY',
 *             marketplace?: 'IT'|'DE'|'FR'|'ES'|'UK'|'ALL' }
 *     → { results: Array<{ productId, ok, message? }> }
 *
 * Loops sequentially through productIds, dispatching the matching
 * per-product publish service. Failures are caught + recorded per
 * product; the loop continues so a single bad product doesn't tank
 * the whole batch.
 *
 * Hard cap: 50 productIds per call. Operators with bigger batches
 * should chunk via the FE.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { submitAmazonImageFeed } from '../services/images/amazon-image-feed.service.js'
// FFP.7 — the Trading-API path (publishEbayImages) is a permanent no-op for
// Inventory-listed products (ebayItemId is null); use the real Inventory push.
import { publishEbayImagesViaInventory } from '../services/images/ebay-inventory-image-publish.service.js'
import { publishShopifyImages } from '../services/images/shopify-image-publish.service.js'
import { recordImagePublishAudit } from '../utils/image-publish-audit.js'

const MAX_PER_CALL = 50

interface PerProductResult {
  productId: string
  ok: boolean
  message?: string
  jobId?: string
  perMarket?: Array<{ marketplace: string; ok: boolean; jobId?: string; error?: string }>
}

const AMAZON_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const

const bulkImagePublishRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: {
      productIds?: string[]
      channel?: string
      marketplace?: string
    }
  }>(
    '/products/bulk-image-publish',
    async (req, reply) => {
      const productIds = Array.isArray(req.body?.productIds) ? req.body!.productIds : []
      const channel = (req.body?.channel ?? '').toUpperCase()
      const marketplace = req.body?.marketplace ? req.body.marketplace.toUpperCase() : null

      if (productIds.length === 0) {
        return reply.code(400).send({ error: 'PRODUCT_IDS_REQUIRED' })
      }
      if (productIds.length > MAX_PER_CALL) {
        return reply.code(400).send({
          error: 'TOO_MANY',
          message: `Max ${MAX_PER_CALL} products per call; chunk larger batches client-side.`,
        })
      }
      if (!['AMAZON', 'EBAY', 'SHOPIFY'].includes(channel)) {
        return reply.code(400).send({ error: 'INVALID_CHANNEL' })
      }
      if (channel === 'AMAZON' && (!marketplace || !['IT', 'DE', 'FR', 'ES', 'UK', 'ALL'].includes(marketplace))) {
        return reply.code(400).send({ error: 'INVALID_MARKETPLACE' })
      }

      // Sanity-check the IDs exist + dedupe in one shot.
      const found = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true },
      })
      const validIds = new Set(found.map((p) => p.id))

      const results: PerProductResult[] = []

      for (const productId of productIds) {
        if (!validIds.has(productId)) {
          results.push({ productId, ok: false, message: 'Product not found' })
          continue
        }
        // PB.16 — Audit log on bulk publish entry. One row per (productId,
        // channel) so the operator can filter by action='imagePublishBulk'.
        void recordImagePublishAudit({
          productId,
          action: 'imagePublishBulk',
          channel: channel as 'AMAZON' | 'EBAY' | 'SHOPIFY',
          marketplace,
          metadata: { batchSize: productIds.length },
        })
        try {
          if (channel === 'AMAZON') {
            const markets = marketplace === 'ALL'
              ? AMAZON_MARKETS
              : [marketplace as typeof AMAZON_MARKETS[number]]
            const perMarket: PerProductResult['perMarket'] = []
            for (const m of markets) {
              try {
                const out = await submitAmazonImageFeed({ productId, marketplace: m })
                perMarket.push({ marketplace: m, ok: true, jobId: out.jobId })
              } catch (err) {
                perMarket.push({
                  marketplace: m,
                  ok: false,
                  error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
                })
              }
            }
            const okCount = perMarket.filter((p) => p.ok).length
            results.push({
              productId,
              ok: okCount > 0,
              perMarket,
              message: okCount === markets.length
                ? `Queued for ${okCount} market${okCount === 1 ? '' : 's'}`
                : `Partial: ${okCount}/${markets.length} markets queued`,
            })
          } else if (channel === 'EBAY') {
            const out = await publishEbayImagesViaInventory(productId)
            results.push({
              productId,
              ok: out.success,
              message: out.message,
            })
          } else if (channel === 'SHOPIFY') {
            const out = await publishShopifyImages(productId)
            results.push({
              productId,
              ok: out.success,
              message: out.message,
            })
          }
        } catch (err) {
          results.push({
            productId,
            ok: false,
            message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          })
        }
      }

      const totalOk = results.filter((r) => r.ok).length
      return reply.send({
        results,
        summary: {
          total: productIds.length,
          ok: totalOk,
          failed: productIds.length - totalOk,
        },
      })
    },
  )
}

export default bulkImagePublishRoutes
