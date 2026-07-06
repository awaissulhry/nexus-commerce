/**
 * IM.9 / IR.9 — eBay + Shopify image publish + cross-channel job log.
 *
 *   POST /api/products/:productId/ebay-images/publish
 *     Body: { activeAxis?: string }
 *     → { success, message, pictureCount, colorSetCount, jobId, error? }
 *
 *   POST /api/products/:productId/shopify-images/publish
 *     Body: { activeAxis?: string }
 *     → { success, message, poolImagesPublished, variantsAssigned, jobId, error? }
 *
 *   GET  /api/products/:productId/image-publish-jobs
 *     → { jobs: UnifiedJob[] }
 *     Unified list across Amazon + eBay + Shopify, newest first.
 *
 *   POST /api/image-publish-jobs/:jobId/retry
 *     → { ok, channel, newJobId, status }
 *     Looks up the job in either AmazonImageFeedJob or
 *     ChannelImagePublishJob, marks the original CANCELLED, re-runs
 *     the publish for the same product + same args.
 */

import type { FastifyPluginAsync } from 'fastify'
import { publishEbayImagesViaInventory } from '../../services/images/ebay-inventory-image-publish.service.js'
import { publishShopifyImages } from '../../services/images/shopify-image-publish.service.js'
import { submitAmazonImageFeed } from '../../services/images/amazon-image-feed.service.js'
import { recordImagePublishAudit } from '../../utils/image-publish-audit.js'
import prisma from '../../db.js'

interface UnifiedJob {
  id: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  marketplace: string | null
  status: string
  errorMessage: string | null
  vendorEntityId: string | null
  submittedAt: string
  completedAt: string | null
  // IA.3 — Per-SKU receipt from Amazon's processing report. Only
  // populated on AMAZON jobs once feed-status reaches DONE. Shape:
  // { perSku: [{ sku, asin, accepted, errors }] } embedded in
  // AmazonImageFeedJob.resultSummary.
  perSku?: Array<{
    sku: string
    asin: string | null
    accepted: boolean
    errors: Array<{ code: string; message: string }>
  }>
}

const channelImagePublishRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/products/:productId/ebay-images/publish ─────────────
  fastify.post<{
    Params: { productId: string }
    Body: { activeAxis?: string }
    Querystring: { marketplace?: string }
  }>(
    '/products/:productId/ebay-images/publish',
    async (request, reply) => {
      const { productId } = request.params
      const marketplace = request.query?.marketplace

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      try {
        const result = await publishEbayImagesViaInventory(productId, marketplace)
        // PB.16 — Audit log.
        void recordImagePublishAudit({
          productId,
          action: result.success ? 'imagePublishCompleted' : 'imagePublishFailed',
          channel: 'EBAY',
          metadata: {
            pictureCount: result.pictureCount,
            colorSetCount: result.colorSetCount,
            ...(result.success ? {} : { error: (result.message ?? '').slice(0, 500) }),
          },
        })
        return reply.code(result.success ? 200 : 422).send(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        void recordImagePublishAudit({
          productId,
          action: 'imagePublishFailed',
          channel: 'EBAY',
          metadata: { error: msg.slice(0, 500) },
        })
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
        // PB.16 — Audit log.
        void recordImagePublishAudit({
          productId,
          action: result.success ? 'imagePublishCompleted' : 'imagePublishFailed',
          channel: 'SHOPIFY',
          metadata: {
            poolImagesPublished: result.poolImagesPublished,
            variantsAssigned: result.variantsAssigned,
            ...(result.success ? {} : { error: (result.message ?? '').slice(0, 500) }),
          },
        })
        return reply.code(result.success ? 200 : 422).send(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        void recordImagePublishAudit({
          productId,
          action: 'imagePublishFailed',
          channel: 'SHOPIFY',
          metadata: { error: msg.slice(0, 500) },
        })
        return reply.code(500).send({ success: false, message: msg, error: msg, poolImagesPublished: 0, variantsAssigned: 0 })
      }
    },
  )

  // ── GET /api/products/:productId/image-publish-jobs ───────────────────
  // IR.9.4 — Unified history across Amazon + eBay + Shopify, newest first.
  fastify.get<{
    Params: { productId: string }
    Querystring: { limit?: string }
  }>(
    '/products/:productId/image-publish-jobs',
    async (request, reply) => {
      const { productId } = request.params
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100)

      const [amazonJobs, channelJobs] = await Promise.all([
        prisma.amazonImageFeedJob.findMany({
          where: { productId },
          orderBy: { submittedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            marketplace: true,
            status: true,
            errorMessage: true,
            feedId: true,
            submittedAt: true,
            completedAt: true,
            // IA.3 — pull resultSummary so the FE can render per-SKU
            // receipts without a second round-trip per job.
            resultSummary: true,
          },
        }),
        prisma.channelImagePublishJob.findMany({
          where: { productId },
          orderBy: { submittedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            channel: true,
            marketplace: true,
            status: true,
            errorMessage: true,
            vendorEntityId: true,
            submittedAt: true,
            completedAt: true,
          },
        }),
      ])

      const unified: UnifiedJob[] = [
        ...amazonJobs.map((j): UnifiedJob => {
          // IA.3 — Surface the per-SKU receipt when present. The raw
          // resultSummary may include other Amazon fields; we only
          // expose perSku to the FE to keep the payload narrow.
          const rs = j.resultSummary as { perSku?: UnifiedJob['perSku'] } | null
          return {
            id: j.id,
            channel: 'AMAZON',
            marketplace: j.marketplace,
            status: j.status,
            errorMessage: j.errorMessage,
            vendorEntityId: j.feedId,
            submittedAt: j.submittedAt.toISOString(),
            completedAt: j.completedAt?.toISOString() ?? null,
            perSku: rs?.perSku,
          }
        }),
        ...channelJobs.map((j): UnifiedJob => ({
          id: j.id,
          channel: j.channel as 'EBAY' | 'SHOPIFY',
          marketplace: j.marketplace,
          status: j.status,
          errorMessage: j.errorMessage,
          vendorEntityId: j.vendorEntityId,
          submittedAt: j.submittedAt.toISOString(),
          completedAt: j.completedAt?.toISOString() ?? null,
        })),
      ]
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        .slice(0, limit)

      return reply.send({ jobs: unified })
    },
  )

  // ── POST /api/image-publish-jobs/:jobId/retry ─────────────────────────
  // IR.9.3 + IA.6 — Find the job (Amazon or channel), mark CANCELLED,
  // re-run publish for the same product. IA.6 adds rejectedOnly mode:
  // when set, the retry targets only SKUs the previous run rejected
  // (from AmazonImageFeedJob.resultSummary.perSku), so accepted ASINs
  // don't get re-hammered. Retry-rejected-only is allowed on DONE
  // jobs since the rejections live inside an otherwise-DONE feed.
  fastify.post<{
    Params: { jobId: string }
    Body: { rejectedOnly?: boolean }
  }>(
    '/image-publish-jobs/:jobId/retry',
    async (request, reply) => {
      const { jobId } = request.params
      const rejectedOnly = request.body?.rejectedOnly === true

      // Try Amazon first.
      const amazonJob = await prisma.amazonImageFeedJob.findUnique({
        where: { id: jobId },
        select: { id: true, productId: true, marketplace: true, status: true, skus: true, resultSummary: true },
      })
      if (amazonJob) {
        // CANCELLED never retryable. DONE retryable ONLY when
        // rejectedOnly=true AND the receipt records at least one
        // rejection — otherwise there's nothing to retry.
        if (amazonJob.status === 'CANCELLED') {
          return reply.code(400).send({ error: 'JOB_NOT_RETRYABLE', status: amazonJob.status })
        }
        if (amazonJob.status === 'DONE' && !rejectedOnly) {
          return reply.code(400).send({ error: 'JOB_NOT_RETRYABLE', status: amazonJob.status })
        }

        // IA.6 — collect rejected SKUs + resolve their variantIds.
        let variantIds: string[] | undefined
        if (rejectedOnly) {
          const rs = amazonJob.resultSummary as { perSku?: Array<{ sku: string; accepted: boolean }> } | null
          const rejectedSkus = (rs?.perSku ?? []).filter((r) => !r.accepted).map((r) => r.sku)
          if (rejectedSkus.length === 0) {
            return reply.code(400).send({ error: 'NOTHING_TO_RETRY', message: 'No rejected SKUs on this feed.' })
          }
          // Resolve variantIds — try child Products first then ProductVariation.
          const [children, pvs] = await Promise.all([
            prisma.product.findMany({
              where: { sku: { in: rejectedSkus }, parentId: amazonJob.productId },
              select: { id: true, sku: true },
            }),
            prisma.productVariation.findMany({
              where: { sku: { in: rejectedSkus }, productId: amazonJob.productId },
              select: { id: true, sku: true },
            }),
          ])
          const idBySku = new Map<string, string>()
          for (const c of children) idBySku.set(c.sku, c.id)
          for (const v of pvs) if (!idBySku.has(v.sku)) idBySku.set(v.sku, v.id)
          variantIds = rejectedSkus.map((s) => idBySku.get(s)).filter((v): v is string => !!v)
          if (variantIds.length === 0) {
            return reply.code(400).send({ error: 'NO_VARIANTS_RESOLVED', message: 'Rejected SKUs no longer match any variant.' })
          }
        }

        // For full-batch retries, mark the old job cancelled so the
        // history shows a clean replacement. Rejected-only retries
        // leave the DONE row intact since the original publish
        // wasn't a failure — just a partial accept.
        if (!rejectedOnly) {
          await prisma.amazonImageFeedJob.update({
            where: { id: amazonJob.id },
            data: { status: 'CANCELLED', completedAt: new Date() },
          })
        }
        try {
          const result = await submitAmazonImageFeed({
            productId: amazonJob.productId,
            marketplace: amazonJob.marketplace,
            variantIds,
          })
          return reply.send({
            ok: true,
            channel: 'AMAZON',
            newJobId: result.jobId,
            status: 'PENDING',
            retried: variantIds?.length ?? null,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return reply.code(502).send({ ok: false, channel: 'AMAZON', message: msg })
        }
      }

      // Then eBay / Shopify.
      const channelJob = await prisma.channelImagePublishJob.findUnique({
        where: { id: jobId },
        select: { id: true, productId: true, channel: true, status: true, requestPayload: true },
      })
      if (!channelJob) return reply.code(404).send({ error: 'JOB_NOT_FOUND' })
      if (['DONE', 'CANCELLED'].includes(channelJob.status)) {
        return reply.code(400).send({ error: 'JOB_NOT_RETRYABLE', status: channelJob.status })
      }

      await prisma.channelImagePublishJob.update({
        where: { id: channelJob.id },
        data: { status: 'CANCELLED', completedAt: new Date() },
      })

      const activeAxis = (channelJob.requestPayload as { activeAxis?: string } | null)?.activeAxis

      try {
        if (channelJob.channel === 'EBAY') {
          const result = await publishEbayImagesViaInventory(channelJob.productId)
          return reply.send({ ok: result.success, channel: 'EBAY', newJobId: result.jobId, status: result.success ? 'DONE' : 'FATAL', error: result.error })
        }
        if (channelJob.channel === 'SHOPIFY') {
          const result = await publishShopifyImages(channelJob.productId, activeAxis)
          return reply.send({ ok: result.success, channel: 'SHOPIFY', newJobId: result.jobId, status: result.success ? 'DONE' : 'FATAL', error: result.error })
        }
        return reply.code(400).send({ error: 'UNKNOWN_CHANNEL', channel: channelJob.channel })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ ok: false, channel: channelJob.channel, message: msg })
      }
    },
  )
}

export default channelImagePublishRoutes
