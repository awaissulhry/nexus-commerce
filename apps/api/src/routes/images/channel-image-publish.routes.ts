/**
 * IM.9 — eBay and Shopify image publish routes.
 *
 *   POST /api/products/:productId/ebay-images/publish
 *     Body: { activeAxis?: string }
 *     → { success, message, pictureCount, colorSetCount, error? }
 *
 *   POST /api/products/:productId/shopify-images/publish
 *     Body: { activeAxis?: string }
 *     → { success, message, poolImagesPublished, variantsAssigned, error? }
 */

import type { FastifyPluginAsync } from 'fastify'
import { publishEbayImages } from '../../services/images/ebay-image-publish.service.js'
import { publishShopifyImages } from '../../services/images/shopify-image-publish.service.js'
import prisma from '../../db.js'

const channelImagePublishRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/products/:productId/ebay-images/publish ─────────────
  fastify.post<{
    Params: { productId: string }
    Body: { activeAxis?: string }
  }>(
    '/products/:productId/ebay-images/publish',
    async (request, reply) => {
      const { productId } = request.params
      const { activeAxis } = request.body ?? ({} as any)

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      try {
        const result = await publishEbayImages(productId, activeAxis)
        return reply.code(result.success ? 200 : 422).send(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ success: false, message: msg, error: msg, pictureCount: 0, colorSetCount: 0 })
      }
    },
  )

  // ── POST /api/products/:productId/shopify-images/publish ───────────
  fastify.post<{
    Params: { productId: string }
    Body: { activeAxis?: string }
  }>(
    '/products/:productId/shopify-images/publish',
    async (request, reply) => {
      const { productId } = request.params
      const { activeAxis } = request.body ?? ({} as any)

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      try {
        const result = await publishShopifyImages(productId, activeAxis)
        return reply.code(result.success ? 200 : 422).send(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ success: false, message: msg, error: msg, poolImagesPublished: 0, variantsAssigned: 0 })
      }
    },
  )
}

export default channelImagePublishRoutes
