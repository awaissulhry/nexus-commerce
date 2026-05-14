/**
 * IM.2 — Images workspace route.
 *
 * Single payload for the new ImagesTab — everything the UI needs in
 * one request:
 *
 *   GET /api/products/:productId/images-workspace
 *   → {
 *       product: { id, sku, name, productType, imageAxisPreference,
 *                  amazonAsin, ebayItemId, shopifyProductId },
 *       master:  ProductImage[],
 *       listing: ListingImage[],              (all scopes / platforms)
 *       variants: VariantSummary[],           (with per-channel IDs)
 *       availableAxes: string[],              (union of variationAttributes keys)
 *       amazonJobs: AmazonImageFeedJob[],     (last 5 per marketplace)
 *     }
 *
 *   PATCH /api/products/:productId/images-workspace/axis
 *     Body: { axis: string }
 *     Persists the operator's chosen grouping axis to Product.imageAxisPreference.
 *
 *   POST /api/products/:productId/images-workspace/bulk-save
 *     Body: { upserts: ListingImageUpsert[], deletes: string[] }
 *     Batch save of pending changes from the UI's dirty state.
 *     Upsert = create-or-update by (productId, variationId, scope,
 *     platform, marketplace, amazonSlot, variantGroupKey, variantGroupValue).
 *
 *   POST /api/products/:productId/images-workspace/copy-scope
 *     Body: { fromScope, fromPlatform?, fromMarketplace?,
 *             toScope,   toPlatform?,   toMarketplace? }
 *     Copies all ListingImages from one bucket to another
 *     (e.g. "apply Master → Amazon IT", "clone IT → DE").
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../../db.js'

type ImageScope = 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'

interface ListingImageUpsert {
  id?: string                 // present = update existing row
  variationId?: string | null
  scope: ImageScope
  platform?: string | null
  marketplace?: string | null
  amazonSlot?: string | null
  variantGroupKey?: string | null
  variantGroupValue?: string | null
  url: string
  filename?: string | null
  role?: string
  position?: number
  sourceProductImageId?: string | null
  width?: number | null
  height?: number | null
  fileSize?: number | null
  mimeType?: string | null
  hasWhiteBackground?: boolean | null
}

function normalizeScopeFields(
  scope: ImageScope,
  platform?: string | null,
  marketplace?: string | null,
) {
  const p = platform ? platform.toUpperCase() : null
  const m = marketplace ? marketplace.toUpperCase() : null
  if (scope === 'GLOBAL') return { platform: null, marketplace: null }
  if (scope === 'PLATFORM') return { platform: p, marketplace: null }
  return { platform: p, marketplace: m }
}

const imagesWorkspaceRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /api/products/:productId/images-workspace ─────────────────
  fastify.get<{
    Params: { productId: string }
  }>(
    '/products/:productId/images-workspace',
    async (request, reply) => {
      const { productId } = request.params

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          sku: true,
          name: true,
          productType: true,
          imageAxisPreference: true,
          amazonAsin: true,
          ebayItemId: true,
          shopifyProductId: true,
          isParent: true,
        },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      const [master, listing, childProducts, pvRecords, recentJobs] = await Promise.all([
        prisma.productImage.findMany({
          where: { productId },
          orderBy: { sortOrder: 'asc' },
        }),

        prisma.listingImage.findMany({
          where: { productId },
          orderBy: [
            { scope: 'asc' },
            { platform: 'asc' },
            { marketplace: 'asc' },
            { position: 'asc' },
          ],
        }),

        // Always query child Products (parentId) — covers both isParent=true
        // and cases where the flag was not set correctly.
        prisma.product.findMany({
          where: { parentId: productId },
          orderBy: { sku: 'asc' },
          select: {
            id: true,
            sku: true,
            name: true,
            variantAttributes: true,
            categoryAttributes: true,
            amazonAsin: true,
          },
        }),

        // Also query ProductVariation records (legacy path / WooCommerce import).
        prisma.productVariation.findMany({
          where: { productId },
          orderBy: { sku: 'asc' },
          select: {
            id: true,
            sku: true,
            variationAttributes: true,
            amazonAsin: true,
            ebayVariationId: true,
            shopifyVariantId: true,
          },
        }),

        prisma.amazonImageFeedJob.findMany({
          where: { productId },
          orderBy: { submittedAt: 'desc' },
          take: 10,
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
        }),
      ])

      // Prefer child Products if they exist; fall back to ProductVariation records.
      const rawVariants = childProducts.length > 0
        ? childProducts.map((c) => {
            // variantAttributes is canonical; fall back to categoryAttributes.variations
            // for products created via the old bulk-create route that left variantAttributes null.
            const catVars = (c.categoryAttributes as Record<string, unknown> | null)?.variations
            const attrs = (c.variantAttributes as Record<string, string> | null)
              ?? (catVars && typeof catVars === 'object' && !Array.isArray(catVars)
                ? catVars as Record<string, string>
                : null)
            return {
              id: c.id,
              sku: c.sku,
              name: c.name ?? c.sku,
              variantAttributes: attrs,
              amazonAsin: c.amazonAsin,
              ebayVariationId: null as string | null,
              shopifyVariantId: null as string | null,
            }
          })
        : pvRecords.map((v) => ({
            id: v.id,
            sku: v.sku,
            name: v.sku,
            variantAttributes: v.variationAttributes as Record<string, string> | null,
            amazonAsin: v.amazonAsin,
            ebayVariationId: v.ebayVariationId,
            shopifyVariantId: v.shopifyVariantId,
          }))

      // Derive available axes from union of variant attribute keys.
      const axisSet = new Set<string>()
      for (const v of rawVariants) {
        if (v.variantAttributes && typeof v.variantAttributes === 'object') {
          Object.keys(v.variantAttributes).forEach((k) => axisSet.add(k))
        }
      }
      const availableAxes = Array.from(axisSet).sort()

      return {
        product,
        master,
        listing,
        variants: rawVariants,
        availableAxes,
        amazonJobs: recentJobs,
      }
    },
  )

  // ── PATCH /api/products/:productId/images-workspace/axis ──────────
  fastify.patch<{
    Params: { productId: string }
    Body: { axis: string }
  }>(
    '/products/:productId/images-workspace/axis',
    async (request, reply) => {
      const { productId } = request.params
      const { axis } = request.body ?? ({} as any)
      if (typeof axis !== 'string' || axis.trim().length === 0) {
        return reply.code(400).send({ error: 'axis required' })
      }
      const updated = await prisma.product.update({
        where: { id: productId },
        data: { imageAxisPreference: axis.trim() },
        select: { id: true, imageAxisPreference: true },
      })
      return updated
    },
  )

  // ── POST /api/products/:productId/images-workspace/bulk-save ──────
  fastify.post<{
    Params: { productId: string }
    Body: {
      upserts?: ListingImageUpsert[]
      deletes?: string[]
    }
  }>(
    '/products/:productId/images-workspace/bulk-save',
    async (request, reply) => {
      const { productId } = request.params
      const { upserts = [], deletes = [] } = request.body ?? ({} as any)

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      await prisma.$transaction(async (tx) => {
        // Deletes first to avoid position conflicts
        if (deletes.length > 0) {
          await tx.listingImage.deleteMany({
            where: { id: { in: deletes }, productId },
          })
        }

        for (const u of upserts) {
          const { platform, marketplace } = normalizeScopeFields(
            u.scope,
            u.platform,
            u.marketplace,
          )

          const data = {
            productId,
            variationId: u.variationId ?? null,
            scope: u.scope as any,
            platform,
            marketplace,
            amazonSlot: u.amazonSlot ?? null,
            variantGroupKey: u.variantGroupKey ?? null,
            variantGroupValue: u.variantGroupValue ?? null,
            url: u.url,
            filename: u.filename ?? null,
            role: (u.role ?? 'GALLERY') as any,
            position: u.position ?? 0,
            sourceProductImageId: u.sourceProductImageId ?? null,
            width: u.width ?? null,
            height: u.height ?? null,
            fileSize: u.fileSize ?? null,
            mimeType: u.mimeType ?? null,
            hasWhiteBackground: u.hasWhiteBackground ?? null,
            publishStatus: 'DRAFT',
            publishError: null,
          }

          if (u.id) {
            await tx.listingImage.update({ where: { id: u.id }, data })
          } else {
            await tx.listingImage.create({ data })
          }
        }
      })

      return {
        saved: upserts.length,
        deleted: deletes.length,
        total: upserts.length + deletes.length,
      }
    },
  )

  // ── POST /api/products/:productId/images-workspace/copy-scope ─────
  fastify.post<{
    Params: { productId: string }
    Body: {
      fromScope: ImageScope
      fromPlatform?: string | null
      fromMarketplace?: string | null
      toScope: ImageScope
      toPlatform?: string | null
      toMarketplace?: string | null
      onlySlots?: string[]    // restrict to specific amazonSlots
      overwrite?: boolean     // default false = skip slots that already exist at target
    }
  }>(
    '/products/:productId/images-workspace/copy-scope',
    async (request, reply) => {
      const { productId } = request.params
      const body = request.body ?? ({} as any)

      const from = normalizeScopeFields(body.fromScope, body.fromPlatform, body.fromMarketplace)
      const to = normalizeScopeFields(body.toScope, body.toPlatform, body.toMarketplace)
      const overwrite = body.overwrite ?? false

      const sourceImages = await prisma.listingImage.findMany({
        where: {
          productId,
          scope: body.fromScope,
          platform: from.platform,
          marketplace: from.marketplace,
          ...(body.onlySlots?.length ? { amazonSlot: { in: body.onlySlots } } : {}),
        },
      })

      if (sourceImages.length === 0) {
        return { copied: 0, skipped: 0 }
      }

      let copied = 0
      let skipped = 0

      for (const src of sourceImages) {
        // Check if target already has an image for the same (variationId, slot/position)
        if (!overwrite) {
          const existing = await prisma.listingImage.findFirst({
            where: {
              productId,
              variationId: src.variationId,
              scope: body.toScope,
              platform: to.platform,
              marketplace: to.marketplace,
              amazonSlot: src.amazonSlot,
            },
          })
          if (existing) { skipped++; continue }
        }

        await prisma.listingImage.create({
          data: {
            productId,
            variationId: src.variationId,
            scope: body.toScope,
            platform: to.platform,
            marketplace: to.marketplace,
            amazonSlot: src.amazonSlot,
            variantGroupKey: src.variantGroupKey,
            variantGroupValue: src.variantGroupValue,
            url: src.url,
            filename: src.filename,
            role: src.role,
            position: src.position,
            sourceProductImageId: src.sourceProductImageId ?? src.id,
            width: src.width,
            height: src.height,
            fileSize: src.fileSize,
            mimeType: src.mimeType,
            hasWhiteBackground: src.hasWhiteBackground,
            publishStatus: 'DRAFT',
          },
        })
        copied++
      }

      return { copied, skipped }
    },
  )
}

export default imagesWorkspaceRoutes
