/**
 * IM.2 — Amazon image routes.  [redeploy 2026-06-07: partial-publish]
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
import { generateAmazonZip, buildAmazonZipManifest } from '../../services/images/amazon-image-zip.service.js'
import { buildAmazonImagePreview } from '../../services/images/amazon-image-preview.service.js'
import { validateAmazonPublish } from '../../services/images/amazon-publish-validator.service.js'
import { findStaleListingImages } from '../../services/images/amazon-stale.service.js'
import { recordImagePublishAudit } from '../../utils/image-publish-audit.js'
import { adoptAmazonImages, reconcileAmazonImages } from '../../services/images/amazon-adopt.service.js'
import { buildMirrorDiff } from '../../services/images/amazon-mirror-diff.service.js'
import { fillSlotsFromGallery } from '../../services/images/amazon-fill-gallery.service.js'
import { marketplaceCodeToId } from '../../utils/marketplace-code.js'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import prisma from '../../db.js'

const VALID_MARKETPLACES = new Set(['IT', 'DE', 'FR', 'ES', 'UK'])

const amazonImagesRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/products/:productId/amazon-images/publish ────────────
  // IA.4 — Runs the validator before submitting. Hard fails (missing
  // MAIN, sub-1000px image, malformed URL) return 422 with the issue
  // list so the operator fixes them before the feed wastes a quota
  // round-trip. Soft warnings (too-few-images, missing-SWCH, non-
  // white-bg MAIN) don't block; they're reported in the response
  // for surfacing in the preview modal.
  //
  // `?force=true` skips the gate — for the "I know better than the
  // validator" case (e.g. Amazon spec changed and our rule is stale).
  fastify.post<{
    Params: { productId: string }
    Body: {
      marketplace: string
      variantIds?: string[]
      activeAxis?: string
      dryRun?: boolean
      force?: boolean
    }
  }>(
    '/products/:productId/amazon-images/publish',
    async (request, reply) => {
      const { productId } = request.params
      const { marketplace, variantIds, activeAxis, dryRun = false, force = false } = request.body ?? ({} as any)

      const mkt = (marketplace ?? '').toUpperCase()
      // M6 — accept ALL configured EU Amazon markets (not just the legacy 5).
      if (!marketplaceCodeToId(mkt)) {
        return reply.code(400).send({
          error: `Invalid/unconfigured Amazon marketplace: ${marketplace}`,
        })
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      // IA.4 — Validation gate. Refuse only when EVERY variant is blocked;
      // otherwise publish the valid variants and skip the blocked ones (the
      // exact-mirror skips MAIN-less ASINs without wiping them on Amazon).
      let publishWarnings: Awaited<ReturnType<typeof validateAmazonPublish>> | null = null
      if (!force) {
        const validation = await validateAmazonPublish({
          productId,
          marketplace: mkt,
          activeAxis,
          variantIds,
        })
        if (validation.hardFails.length > 0) {
          const allBlocked =
            validation.summary.totalAsins > 0 &&
            validation.summary.asinsBlocked >= validation.summary.totalAsins
          if (allBlocked) {
            return reply.code(422).send({
              error: 'VALIDATION_FAILED',
              message: `Every variant is blocked: ${validation.hardFails.length} issue${validation.hardFails.length === 1 ? '' : 's'} (e.g. "${validation.hardFails[0]?.message}"). Fix the images — a MAIN is required — or resubmit with force=true.`,
              hardFails: validation.hardFails,
              softWarnings: validation.softWarnings,
              summary: validation.summary,
            })
          }
          // Some variants are valid → publish those; the blocked ones are skipped.
          publishWarnings = validation
        }
      }

      try {
        const result = await submitAmazonImageFeed({
          productId,
          marketplace: mkt,
          variantIds,
          activeAxis,
          dryRun,
        })
        // PB.16 — Audit log on the route entry. The async feed terminal
        // status (DONE / FATAL) writes a follow-up audit row from
        // pollAndUpdateFeedJob if/when we wire that.
        void recordImagePublishAudit({
          productId,
          action: 'imagePublishStarted',
          channel: 'AMAZON',
          marketplace: mkt,
          metadata: {
            jobId: result.jobId,
            feedId: result.feedId,
            skuCount: result.skus.length,
            dryRun,
            forced: force,
            variantIds: variantIds && variantIds.length > 0 ? variantIds : undefined,
          },
        })
        return publishWarnings
          ? { ...result, skippedAsins: publishWarnings.summary.asinsBlocked, skippedIssues: publishWarnings.hardFails }
          : result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        void recordImagePublishAudit({
          productId,
          action: 'imagePublishFailed',
          channel: 'AMAZON',
          marketplace: mkt,
          metadata: { error: msg.slice(0, 500) },
        })
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // ── POST /api/products/:productId/amazon-images/adopt ──────────────
  // M2 — Lossless adopt-first: pull all live Amazon images (all configured
  // EU markets, all slots incl. PS) into a per-market ListingImage baseline
  // so the exact-mirror publish (M3) never wipes manual Seller Central
  // uploads. dryRun reports counts without writing.
  fastify.post<{
    Params: { productId: string }
    Body: { marketplaces?: string[]; dryRun?: boolean }
  }>('/products/:productId/amazon-images/adopt', async (request, reply) => {
    const { productId } = request.params
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
    if (!product) return reply.code(404).send({ error: 'Product not found' })
    try {
      const result = await adoptAmazonImages({
        productId,
        marketplaces: request.body?.marketplaces,
        dryRun: request.body?.dryRun ?? false,
      })
      void recordImagePublishAudit({
        productId,
        action: 'imagesAdopted',
        channel: 'AMAZON',
        metadata: {
          dryRun: result.dryRun,
          perMarket: result.perMarket.map((m) => ({ marketplace: m.marketplace, created: m.created, skipped: m.skippedExisting })),
        },
      })
      return result
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── GET /api/products/:productId/amazon-images/reconcile ───────────
  // M2 — Read-only diff: Amazon live vs the Nexus baseline per market.
  // After a clean adopt, onlyOnAmazon should be empty. ?refresh=1 re-pulls
  // live from Amazon first; ?marketplaces=IT,DE scopes the markets.
  fastify.get<{
    Params: { productId: string }
    Querystring: { marketplaces?: string; refresh?: string }
  }>('/products/:productId/amazon-images/reconcile', async (request, reply) => {
    const { productId } = request.params
    const marketplaces = request.query.marketplaces
      ? request.query.marketplaces.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      : undefined
    try {
      const result = await reconcileAmazonImages({
        productId,
        marketplaces,
        refresh: request.query.refresh === '1' || request.query.refresh === 'true',
      })
      return result
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── GET /api/products/:productId/amazon-images/mirror-diff ─────────
  // M4 — what an exact-mirror publish WOULD change on Amazon (adds /
  // replaces / DELETES) per ASIN vs the live state. The pre-publish safety
  // surface — `deletes` lists only images that would actually be removed.
  fastify.get<{
    Params: { productId: string }
    Querystring: { marketplace?: string; activeAxis?: string }
  }>('/products/:productId/amazon-images/mirror-diff', async (request, reply) => {
    const mkt = (request.query.marketplace ?? '').toUpperCase()
    if (!mkt) return reply.code(400).send({ error: 'marketplace required' })
    try {
      const diff = await buildMirrorDiff({
        productId: request.params.productId,
        marketplace: mkt,
        activeAxis: request.query.activeAxis,
      })
      return diff
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── GET .../amazon-images/debug-live/:sku — TEMP read-only probe ───
  // For one SKU+marketplace: the image ATTRIBUTES our feed sets vs the
  // PROCESSED images Amazon returns vs any issues — to pin down why an accepted
  // feed isn't reflected on the listing. Calls getListingsItem only (read-only).
  fastify.get<{
    Params: { productId: string; sku: string }
    Querystring: { marketplace?: string }
  }>('/products/:productId/amazon-images/debug-live/:sku', async (request, reply) => {
    const mkt = (request.query.marketplace ?? 'ES').toUpperCase()
    const marketplaceId = marketplaceCodeToId(mkt)
    if (!marketplaceId) return reply.code(400).send({ error: `bad marketplace ${mkt}` })
    const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
    try {
      const res = await amazonSpApiClient.getListingsItem({
        sellerId,
        sku: request.params.sku,
        marketplaceId,
        includedData: ['summaries', 'attributes', 'images', 'issues', 'relationships'] as any,
      })
      const raw = (res.rawResponse ?? {}) as any
      const attrs = raw.attributes ?? {}
      const imageAttributes: Record<string, unknown> = {}
      for (const k of Object.keys(attrs)) if (/image/i.test(k)) imageAttributes[k] = attrs[k]
      return {
        sku: request.params.sku,
        marketplace: mkt,
        asin: res.asin,
        status: res.status,
        processedImagesCount: (res.images ?? []).length,
        imageAttributeKeys: Object.keys(imageAttributes),
        imageAttributes,
        issues: raw.issues ?? [],
        relationships: raw.relationships ?? [],
      }
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── POST /api/products/:productId/amazon-images/fill-from-gallery ──
  // M6 — one-click "gallery = Amazon": map the master gallery onto Amazon
  // slots (MAIN + PT in order) as product-level Amazon assignments, so the
  // exact-mirror publish makes Amazon match the Nexus gallery. dryRun returns
  // the plan; overwrite rewires existing product-level slots.
  fastify.post<{
    Params: { productId: string }
    Body: { dryRun?: boolean; overwrite?: boolean; marketplace?: string }
  }>('/products/:productId/amazon-images/fill-from-gallery', async (request, reply) => {
    const { productId } = request.params
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
    if (!product) return reply.code(404).send({ error: 'Product not found' })
    try {
      const result = await fillSlotsFromGallery({
        productId,
        dryRun: request.body?.dryRun ?? false,
        overwrite: request.body?.overwrite ?? false,
        marketplace: request.body?.marketplace,
      })
      return result
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── GET /api/products/:productId/amazon-images/validate ────────────
  // IA.4 — Standalone validation surface for the preview modal so the
  // operator sees blocking issues + warnings WITHOUT triggering a
  // publish attempt. Same checks as the gate above.
  fastify.get<{
    Params: { productId: string }
    Querystring: { marketplace?: string; activeAxis?: string }
  }>(
    '/products/:productId/amazon-images/validate',
    async (request, reply) => {
      const { productId } = request.params
      const mkt = (request.query.marketplace ?? '').toUpperCase()
      if (!VALID_MARKETPLACES.has(mkt)) {
        return reply.code(400).send({ error: `Invalid marketplace: ${mkt}` })
      }
      try {
        const validation = await validateAmazonPublish({
          productId,
          marketplace: mkt,
          activeAxis: request.query.activeAxis ?? null,
        })
        // blockedAsins is a Set — convert to array for JSON.
        return {
          ...validation,
          blockedAsins: Array.from(validation.blockedAsins),
        }
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

  // ── GET /api/products/:productId/amazon-images/preview ─────────────
  // IA.2 — Pre-publish preview. Returns the per-ASIN per-slot plan
  // the publisher would submit on the next Submit click, including
  // coverage stats (filled/total, hasMain). FE renders this as a
  // confirmation table so the operator commits with their eyes open.
  fastify.get<{
    Params: { productId: string }
    Querystring: { marketplace?: string; activeAxis?: string }
  }>(
    '/products/:productId/amazon-images/preview',
    async (request, reply) => {
      const { productId } = request.params
      const mkt = (request.query.marketplace ?? '').toUpperCase()
      if (!VALID_MARKETPLACES.has(mkt)) {
        return reply.code(400).send({ error: `Invalid marketplace: ${mkt}` })
      }
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })
      try {
        const preview = await buildAmazonImagePreview({
          productId,
          marketplace: mkt,
          activeAxis: request.query.activeAxis ?? null,
        })
        return preview
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // ── GET /api/products/:productId/amazon-images/stale ───────────────
  // IA.5 — Detect ListingImage rows that were published but the
  // master image has been updated since. The banner above the
  // matrix surfaces this so the operator one-click re-publishes
  // just the stale ASINs.
  fastify.get<{
    Params: { productId: string }
    Querystring: { marketplace?: string }
  }>(
    '/products/:productId/amazon-images/stale',
    async (request, reply) => {
      const { productId } = request.params
      const mkt = (request.query.marketplace ?? '').toUpperCase()
      if (!VALID_MARKETPLACES.has(mkt)) {
        return reply.code(400).send({ error: `Invalid marketplace: ${mkt}` })
      }
      try {
        const result = await findStaleListingImages({ productId, marketplace: mkt })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // ── POST /api/products/:productId/amazon-images/export-zip ─────────
  // IA.1 — accepts marketplace='ALL' (per-market folders) and
  // activeAxis (operator's grouping axis, e.g. 'Color') so the
  // resolver honours per-group overrides instead of silently dropping
  // them. Response headers carry the counts so the FE can surface
  // "X files, Y errors" without parsing the body.
  fastify.post<{
    Params: { productId: string }
    Body: {
      marketplace: string
      activeAxis?: string | null
      variantIds?: string[]
      filenameTemplate?: 'asin' | 'sku'
    }
  }>(
    '/products/:productId/amazon-images/export-zip',
    async (request, reply) => {
      const { productId } = request.params
      const { marketplace, activeAxis, variantIds, filenameTemplate, includePs } = request.body ?? ({} as any)

      const mkt = (marketplace ?? '').toUpperCase()
      const isAll = mkt === 'ALL'
      if (!isAll && !VALID_MARKETPLACES.has(mkt)) {
        return reply.code(400).send({ error: `Invalid marketplace: ${marketplace}` })
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      try {
        const { buffer, filename, fileCount, skippedNoAsin, errors } =
          await generateAmazonZip({ productId, marketplace: mkt, activeAxis, variantIds, filenameTemplate, includePs })

        if (fileCount === 0) {
          return reply.code(422).send({
            error: 'No images resolved for export',
            skippedNoAsin,
            errors,
          })
        }

        // X-Errors header surfaces the per-image failure count without
        // requiring the FE to read the body (which is the ZIP bytes).
        reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .header('X-File-Count', String(fileCount))
          .header('X-Skipped-No-Asin', skippedNoAsin.join(','))
          .header('X-Errors', String(errors.length))
        return reply.send(buffer)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // ── GET /api/products/:productId/amazon-images/export-zip/manifest ─
  // Pre-export coverage: per-market ASIN/file counts + skipped (no ASIN) +
  // blocked (validation) ASINs, WITHOUT downloading images. Powers the export
  // preview + completeness report so nothing is silently missing.
  fastify.get<{
    Params: { productId: string }
    Querystring: { marketplace?: string; activeAxis?: string; includePs?: string }
  }>(
    '/products/:productId/amazon-images/export-zip/manifest',
    async (request, reply) => {
      const mkt = (request.query.marketplace ?? 'ALL').toUpperCase()
      try {
        const manifest = await buildAmazonZipManifest({
          productId: request.params.productId,
          marketplace: mkt,
          activeAxis: request.query.activeAxis ?? null,
          includePs: request.query.includePs !== 'false',
        })
        return manifest
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
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
