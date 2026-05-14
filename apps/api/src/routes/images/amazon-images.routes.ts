/**
 * IM.2 — Amazon image routes.
 *
 *   POST /api/products/:productId/amazon-images/publish
 *     Resolves + submits a JSON_LISTINGS_FEED for the product's images.
 *     Body: { marketplace, variantIds?, dryRun? }
 *     Returns: { feedId, jobId, skus, skippedNoAsin, skippedNoImages, dryRun }
 *
 *   GET /api/products/:productId/amazon-images/feed-status/:jobId
 *     Polls Amazon for the feed's processing status and writes results
 *     back to ListingImage rows when DONE.
 *     Returns: { jobId, status, resultSummary? }
 *
 *   POST /api/products/:productId/amazon-images/export-zip
 *     Generates and streams a ZIP file named per Amazon's convention:
 *       {ASIN}.{SLOT}.{ext}
 *     Body: { marketplace, variantIds? }
 *     Streams: ZIP binary with Content-Disposition attachment header
 *
 *   GET /api/products/:productId/amazon-images/jobs
 *     Lists recent AmazonImageFeedJob rows for the product.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  submitAmazonImageFeed,
  pollAndUpdateFeedJob,
} from '../../services/images/amazon-image-feed.service.js'
import { generateAmazonZip } from '../../services/images/amazon-image-zip.service.js'
import prisma from '../../db.js'

const VALID_MARKETPLACES = new Set(['IT', 'DE', 'FR', 'ES', 'UK'])

const amazonImagesRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/products/:productId/amazon-images/publish ────────────
  fastify.post<{
    Params: { productId: string }
    Body: {
      marketplace: string
      variantIds?: string[]
      activeAxis?: string
      dryRun?: boolean
    }
  }>(
    '/products/:productId/amazon-images/publish',
    async (request, reply) => {
      const { productId } = request.params
      const { marketplace, variantIds, activeAxis, dryRun = false } = request.body ?? ({} as any)

      const mkt = (marketplace ?? '').toUpperCase()
      if (!VALID_MARKETPLACES.has(mkt)) {
        return reply.code(400).send({
          error: `Invalid marketplace: ${marketplace}. Valid: IT, DE, FR, ES, UK`,
        })
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      try {
        const result = await submitAmazonImageFeed({
          productId,
          marketplace: mkt,
          variantIds,
          activeAxis,
          dryRun,
        })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // ── GET /api/products/:productId/amazon-images/feed-status/:jobId ──
  fastify.get<{
    Params: { productId: string; jobId: string }
  }>(
    '/products/:productId/amazon-images/feed-status/:jobId',
    async (request, reply) => {
      const { jobId } = request.params
      try {
        const result = await pollAndUpdateFeedJob(jobId)
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // ── POST /api/products/:productId/amazon-images/export-zip ─────────
  fastify.post<{
    Params: { productId: string }
    Body: { marketplace: string; variantIds?: string[] }
  }>(
    '/products/:productId/amazon-images/export-zip',
    async (request, reply) => {
      const { productId } = request.params
      const { marketplace, variantIds } = request.body ?? ({} as any)

      const mkt = (marketplace ?? '').toUpperCase()
      if (!VALID_MARKETPLACES.has(mkt)) {
        return reply.code(400).send({ error: `Invalid marketplace: ${marketplace}` })
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      try {
        const { buffer, filename, fileCount, skippedNoAsin } =
          await generateAmazonZip({ productId, marketplace: mkt, variantIds })

        if (fileCount === 0) {
          return reply.code(422).send({
            error: 'No images resolved for export',
            skippedNoAsin,
          })
        }

        reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .header('X-File-Count', String(fileCount))
          .header('X-Skipped-No-Asin', skippedNoAsin.join(','))
        return reply.send(buffer)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // ── GET /api/products/:productId/amazon-images/jobs ────────────────
  fastify.get<{
    Params: { productId: string }
    Querystring: { marketplace?: string; limit?: string }
  }>(
    '/products/:productId/amazon-images/jobs',
    async (request, reply) => {
      const { productId } = request.params
      const marketplace = request.query.marketplace?.toUpperCase()
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100)

      const jobs = await prisma.amazonImageFeedJob.findMany({
        where: {
          productId,
          ...(marketplace ? { marketplace } : {}),
        },
        orderBy: { submittedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          marketplace: true,
          feedId: true,
          status: true,
          skus: true,
          errorMessage: true,
          resultSummary: true,
          submittedAt: true,
          completedAt: true,
        },
      })

      return { jobs }
    },
  )
}

export default amazonImagesRoutes
