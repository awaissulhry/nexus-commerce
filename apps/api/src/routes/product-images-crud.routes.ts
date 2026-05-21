/**
 * W8.1 — Per-product master image management.
 *
 *   GET    /api/products/:id/images
 *     → ProductImage[]  (sorted by sortOrder ASC, then createdAt)
 *
 *   POST   /api/products/:id/images
 *     multipart: file (required), type? ('MAIN'|'ALT'|'LIFESTYLE'|'SWATCH'|'DIAGRAM'), alt?
 *     → ProductImage
 *
 *   PATCH  /api/products/:id/images/:imageId
 *     body: { alt?, type? }
 *     → ProductImage
 *
 *   DELETE /api/products/:id/images/:imageId
 *     Deletes from DB. If the image has a publicId, also removes from Cloudinary.
 *     → { deleted: true }
 *
 *   POST   /api/products/:id/images/reorder
 *     body: { order: Array<{ id: string; sortOrder: number }> }
 *     Writes each row's new sortOrder. Client sends the complete new sequence.
 *     → { updated: number }
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  buildAutoEnhanceUrl,
  buildDerivedUrl,
  deleteFromCloudinary,
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
  type AutoEnhancePreset,
  type DeriveTransforms,
} from '../services/cloudinary.service.js'
import { analyzeProductImage } from '../services/ai/image-vision.service.js'
import { generateLifestyleImage, type ImagenAspectRatio } from '../services/ai/image-generation.service.js'
import { applyImagesToProducts } from '../services/images/bulk-apply.service.js'

const VALID_ASPECT_RATIOS: ImagenAspectRatio[] = ['1:1', '3:4', '4:3', '9:16', '16:9']

const VALID_PRESETS: AutoEnhancePreset[] = ['AMAZON_MAIN', 'EBAY_MAIN', 'SHOPIFY_PORTRAIT']

const VALID_TYPES = new Set(['MAIN', 'ALT', 'LIFESTYLE', 'SWATCH', 'DIAGRAM'])

// Cloudinary returns `format` as a bare extension ('jpg', 'png', 'webp', ...).
// Convert to a proper MIME type so the ProductImage.mimeType column matches
// ListingImage.mimeType conventions ('image/jpeg', etc.) and downstream
// validation can compare against acceptedMimeTypes lists uniformly.
function formatToMimeType(format: string | undefined): string | null {
  if (!format) return null
  const f = format.toLowerCase()
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg'
  if (f === 'png') return 'image/png'
  if (f === 'webp') return 'image/webp'
  if (f === 'gif') return 'image/gif'
  if (f === 'svg') return 'image/svg+xml'
  if (f === 'avif') return 'image/avif'
  if (f === 'heic' || f === 'heif') return 'image/heic'
  return `image/${f}`
}

const productImagesCrudRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /api/products/:id/images ─────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/images',
    async (req, reply) => {
      const images = await prisma.productImage.findMany({
        where: { productId: req.params.id },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      })
      return reply.send(images)
    },
  )

  // ── POST /api/products/:id/images (multipart upload) ─────────────────
  fastify.post<{
    Params: { id: string }
    Querystring: { type?: string; alt?: string }
  }>(
    '/products/:id/images',
    async (req, reply) => {
      const { id } = req.params
      const product = await prisma.product.findUnique({ where: { id }, select: { id: true } })
      if (!product) return reply.status(404).send({ error: 'PRODUCT_NOT_FOUND' })

      const data = await req.file()
      if (!data) return reply.status(400).send({ error: 'NO_FILE' })

      const type = req.query.type ?? 'ALT'
      if (!VALID_TYPES.has(type)) {
        return reply.status(400).send({ error: 'INVALID_TYPE', validTypes: [...VALID_TYPES] })
      }
      const alt = req.query.alt ?? null

      // Count existing images to assign next sortOrder
      const existing = await prisma.productImage.count({ where: { productId: id } })

      if (!isCloudinaryConfigured()) {
        return reply.status(503).send({ error: 'CLOUDINARY_NOT_CONFIGURED' })
      }

      const buf = await data.toBuffer()
      const cloudResult = await uploadBufferToCloudinary(buf, {
        folder: `product-images/${id}`,
      })

      const image = await prisma.productImage.create({
        data: {
          productId: id,
          url: cloudResult.url,
          publicId: cloudResult.publicId,
          type,
          alt,
          sortOrder: existing,
          // IR.2.2 — persist Cloudinary's asset metadata so QualityChecklist
          // + Amazon matrix dim warnings + master gallery card subtitle
          // have real numbers to read instead of guessing.
          width: cloudResult.width,
          height: cloudResult.height,
          fileSize: cloudResult.bytes,
          mimeType: formatToMimeType(cloudResult.format),
        },
      })

      return reply.status(201).send(image)
    },
  )

  // ── POST /api/products/:id/images/reorder ────────────────────────────
  fastify.post<{
    Params: { id: string }
    Body: { order?: Array<{ id: string; sortOrder: number }> }
  }>(
    '/products/:id/images/reorder',
    async (req, reply) => {
      const { id } = req.params
      const order = req.body?.order
      if (!Array.isArray(order) || order.length === 0) {
        return reply.status(400).send({ error: 'INVALID_ORDER' })
      }

      // Verify all IDs belong to this product
      const owned = await prisma.productImage.findMany({
        where: { productId: id },
        select: { id: true },
      })
      const ownedSet = new Set(owned.map((r) => r.id))
      if (!order.every((row) => ownedSet.has(row.id))) {
        return reply.status(400).send({ error: 'FOREIGN_IMAGE_ID' })
      }

      await prisma.$transaction(
        order.map((row) =>
          prisma.productImage.update({
            where: { id: row.id },
            data: { sortOrder: row.sortOrder },
          }),
        ),
      )

      return reply.send({ updated: order.length })
    },
  )

  // ── PATCH /api/products/:id/images/:imageId ──────────────────────────
  fastify.patch<{
    Params: { id: string; imageId: string }
    Body: { alt?: string | null; type?: string }
  }>(
    '/products/:id/images/:imageId',
    async (req, reply) => {
      const { id, imageId } = req.params
      const existing = await prisma.productImage.findFirst({
        where: { id: imageId, productId: id },
      })
      if (!existing) return reply.status(404).send({ error: 'IMAGE_NOT_FOUND' })

      const { alt, type } = req.body ?? {}
      if (type !== undefined && !VALID_TYPES.has(type)) {
        return reply.status(400).send({ error: 'INVALID_TYPE' })
      }

      const updated = await prisma.productImage.update({
        where: { id: imageId },
        data: {
          ...(alt !== undefined && { alt }),
          ...(type !== undefined && { type }),
        },
      })
      return reply.send(updated)
    },
  )

  // ── POST /api/products/:id/images/:imageId/derive ────────────────────
  // IR.4.2 — Create a new ProductImage as a Cloudinary-transformation
  // derivative of the source. No re-upload — the new row's URL is just
  // a fresh signed URL pointing at the same source bytes with the
  // operator's crop/rotate/flip chain baked into the path.
  fastify.post<{
    Params: { id: string; imageId: string }
    Body: DeriveTransforms & {
      type?: string
      alt?: string | null
    }
  }>(
    '/products/:id/images/:imageId/derive',
    async (req, reply) => {
      const { id, imageId } = req.params
      const source = await prisma.productImage.findFirst({
        where: { id: imageId, productId: id },
      })
      if (!source) return reply.status(404).send({ error: 'IMAGE_NOT_FOUND' })
      if (!source.publicId) {
        return reply.status(400).send({
          error: 'NO_PUBLIC_ID',
          message: 'Source image has no Cloudinary publicId (legacy or external import) — cannot derive in-place.',
        })
      }

      const body = req.body ?? {}
      const { crop, rotate, flipH, flipV, type: typeOverride, alt: altOverride } = body

      // At least one transform must be requested.
      const hasTransform = !!crop || (typeof rotate === 'number' && rotate !== 0) || flipH || flipV
      if (!hasTransform) {
        return reply.status(400).send({ error: 'NO_TRANSFORMS' })
      }

      if (typeOverride !== undefined && !VALID_TYPES.has(typeOverride)) {
        return reply.status(400).send({ error: 'INVALID_TYPE', validTypes: [...VALID_TYPES] })
      }

      if (!isCloudinaryConfigured()) {
        return reply.status(503).send({ error: 'CLOUDINARY_NOT_CONFIGURED' })
      }

      // Compute derived dimensions from the request — Cloudinary doesn't
      // round-trip metadata on transformation URLs, and re-fetching to
      // measure adds latency. crop's w/h is authoritative; pure rotation
      // ±90° swaps axes.
      let derivedWidth: number | null = source.width
      let derivedHeight: number | null = source.height
      if (crop) {
        derivedWidth = Math.round(crop.width)
        derivedHeight = Math.round(crop.height)
      }
      if (typeof rotate === 'number' && Math.abs(rotate) % 180 === 90) {
        ;[derivedWidth, derivedHeight] = [derivedHeight, derivedWidth]
      }

      const derivedUrl = buildDerivedUrl(source.publicId, { crop, rotate, flipH, flipV })

      const count = await prisma.productImage.count({ where: { productId: id } })

      const created = await prisma.productImage.create({
        data: {
          productId: id,
          url: derivedUrl,
          // publicId stays NULL — this row doesn't own a Cloudinary asset.
          // Deleting it doesn't remove the source; deleting the source
          // sets derivedFromImageId to NULL via the FK.
          publicId: null,
          type: typeOverride ?? source.type,
          alt: altOverride !== undefined ? altOverride : source.alt,
          sortOrder: count,
          width: derivedWidth,
          height: derivedHeight,
          mimeType: source.mimeType,
          // fileSize stays NULL — transformations change byte count
          // unpredictably and a HEAD request to measure would slow the
          // request path. Set when the derivative is first served.
          fileSize: null,
          derivedFromImageId: source.id,
        },
      })

      return reply.status(201).send(created)
    },
  )

  // ── POST /api/products/:id/images/:imageId/auto-enhance ──────────────
  // IR.6.4 — Apply a marketplace-tuned Cloudinary chain (background
  // removal + white pad + square or portrait) and save the result as
  // a derivative. Single click → derivative ready to assign.
  fastify.post<{
    Params: { id: string; imageId: string }
    Body: { preset?: AutoEnhancePreset; type?: string; alt?: string | null }
  }>(
    '/products/:id/images/:imageId/auto-enhance',
    async (req, reply) => {
      const { id, imageId } = req.params
      const source = await prisma.productImage.findFirst({
        where: { id: imageId, productId: id },
      })
      if (!source) return reply.status(404).send({ error: 'IMAGE_NOT_FOUND' })
      if (!source.publicId) {
        return reply.status(400).send({
          error: 'NO_PUBLIC_ID',
          message: 'Source image has no Cloudinary publicId — auto-enhance only works on images we own.',
        })
      }

      const preset = req.body?.preset ?? 'AMAZON_MAIN'
      if (!VALID_PRESETS.includes(preset)) {
        return reply.status(400).send({ error: 'INVALID_PRESET', validPresets: VALID_PRESETS })
      }

      if (!isCloudinaryConfigured()) {
        return reply.status(503).send({ error: 'CLOUDINARY_NOT_CONFIGURED' })
      }

      const { url, width, height } = buildAutoEnhanceUrl(source.publicId, preset)
      const count = await prisma.productImage.count({ where: { productId: id } })

      const created = await prisma.productImage.create({
        data: {
          productId: id,
          url,
          publicId: null,
          type: req.body?.type ?? source.type,
          alt: req.body?.alt !== undefined ? req.body.alt : source.alt,
          sortOrder: count,
          width,
          height,
          mimeType: 'image/jpeg', // Cloudinary serves auto-format; jpeg is the broad-compat default
          fileSize: null,
          derivedFromImageId: source.id,
        },
      })

      return reply.status(201).send({ ok: true, preset, image: created })
    },
  )

  // ── POST /api/products/:id/images/apply-to-children ──────────────────
  // IR.8.1 — Parent-only bulk action. Mirrors this product's master
  // gallery onto every child Product (parentId === :id). Each affected
  // child gets an AuditLog row. Returns counts so the FE can show a
  // result toast without polling.
  fastify.post<{
    Params: { id: string }
    Body: { mode?: 'replace' | 'append' }
  }>(
    '/products/:id/images/apply-to-children',
    async (req, reply) => {
      const { id } = req.params
      const mode = req.body?.mode ?? 'replace'

      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true, isParent: true },
      })
      if (!product) return reply.status(404).send({ error: 'PRODUCT_NOT_FOUND' })
      if (!product.isParent) {
        return reply.status(400).send({
          error: 'NOT_A_PARENT',
          message: 'apply-to-children only works on parent products (isParent=true).',
        })
      }

      const children = await prisma.product.findMany({
        where: { parentId: id },
        select: { id: true },
      })
      if (children.length === 0) {
        return reply.send({
          sourceProductId: id,
          targetsTotal: 0,
          targetsUpdated: 0,
          imagesCreated: 0,
          imagesDeleted: 0,
          errors: [],
        })
      }

      const result = await applyImagesToProducts({
        sourceProductId: id,
        targetProductIds: children.map((c) => c.id),
        mode,
      })
      return reply.send(result)
    },
  )

  // ── POST /api/products/images/bulk-apply ─────────────────────────────
  // IR.8.2 — Generic bulk apply. Operator picks a source + a list of
  // arbitrary targets (typically gathered from a multi-select on the
  // /products listing). Same per-target transaction + audit pattern
  // as apply-to-children.
  fastify.post<{
    Body: {
      sourceProductId?: string
      targetProductIds?: string[]
      mode?: 'replace' | 'append'
    }
  }>(
    '/products/images/bulk-apply',
    async (req, reply) => {
      const { sourceProductId, targetProductIds, mode = 'replace' } = req.body ?? {}
      if (!sourceProductId) return reply.status(400).send({ error: 'SOURCE_REQUIRED' })
      if (!Array.isArray(targetProductIds) || targetProductIds.length === 0) {
        return reply.status(400).send({ error: 'TARGETS_REQUIRED' })
      }
      if (targetProductIds.length > 500) {
        return reply.status(400).send({
          error: 'TOO_MANY_TARGETS',
          message: 'Hard cap of 500 targets per call. Split into smaller batches.',
        })
      }

      try {
        const result = await applyImagesToProducts({
          sourceProductId,
          targetProductIds,
          mode,
        })
        return reply.send(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Bulk apply failed'
        return reply.status(message.startsWith('SOURCE_NOT_FOUND') ? 404 : 500).send({
          error: 'BULK_APPLY_FAILED',
          message,
        })
      }
    },
  )

  // ── POST /api/products/:id/images/import-from-dam ────────────────────
  // IR.7.4 — Pull a DigitalAsset into the product's master gallery.
  // Creates a ProductImage that mirrors the asset's storage + dim
  // metadata, plus an AssetUsage row so the DAM library can show
  // "used in this product" on its side.
  fastify.post<{
    Params: { id: string }
    Body: { assetId: string; type?: string; alt?: string | null }
  }>(
    '/products/:id/images/import-from-dam',
    async (req, reply) => {
      const { id } = req.params
      const { assetId, type, alt } = req.body ?? ({} as any)
      if (!assetId) return reply.status(400).send({ error: 'ASSET_ID_REQUIRED' })
      if (type !== undefined && !VALID_TYPES.has(type)) {
        return reply.status(400).send({ error: 'INVALID_TYPE', validTypes: [...VALID_TYPES] })
      }

      const product = await prisma.product.findUnique({ where: { id }, select: { id: true } })
      if (!product) return reply.status(404).send({ error: 'PRODUCT_NOT_FOUND' })

      const asset = await prisma.digitalAsset.findUnique({ where: { id: assetId } })
      if (!asset) return reply.status(404).send({ error: 'ASSET_NOT_FOUND' })
      if (asset.type !== 'image') {
        return reply.status(400).send({ error: 'ASSET_NOT_IMAGE', assetType: asset.type })
      }

      const meta = (asset.metadata ?? null) as Record<string, unknown> | null
      const width = typeof meta?.width === 'number' ? meta.width : null
      const height = typeof meta?.height === 'number' ? meta.height : null

      const count = await prisma.productImage.count({ where: { productId: id } })
      const resolvedType = type ?? 'ALT'
      const resolvedAlt = alt !== undefined ? alt : (asset.label || null)

      // Reuse-or-create ProductImage by (productId, publicId). Prevents
      // double-import on rapid clicks + keeps the round-trip idempotent.
      const existing = asset.storageProvider === 'cloudinary'
        ? await prisma.productImage.findFirst({
            where: { productId: id, publicId: asset.storageId },
          })
        : null

      const image = existing ?? await prisma.productImage.create({
        data: {
          productId: id,
          url: asset.url,
          publicId: asset.storageProvider === 'cloudinary' ? asset.storageId : null,
          type: resolvedType,
          alt: resolvedAlt,
          sortOrder: count,
          width,
          height,
          mimeType: asset.mimeType,
          fileSize: asset.sizeBytes || null,
        },
      })

      // Best-effort AssetUsage mirror so the DAM side reflects the link.
      const existingUsage = await prisma.assetUsage.findFirst({
        where: { assetId: asset.id, scope: 'product', productId: id, role: resolvedType.toLowerCase() },
      })
      if (!existingUsage) {
        await prisma.assetUsage.create({
          data: {
            assetId: asset.id,
            scope: 'product',
            productId: id,
            role: resolvedType.toLowerCase(),
            sortOrder: image.sortOrder,
          },
        })
      }

      return reply.status(existing ? 200 : 201).send({ ok: true, image, reused: !!existing })
    },
  )

  // ── POST /api/products/:id/images/:imageId/push-to-dam ───────────────
  // IR.7.1 — Bridge master gallery → DAM library. Creates a
  // DigitalAsset reusing the same Cloudinary publicId as storageId,
  // plus an AssetUsage scoping it to the product with role mirroring
  // the ProductImage.type.
  //
  // Idempotent: if a DigitalAsset already exists with this storageId,
  // we reuse it instead of duplicating. Same for the AssetUsage row.
  fastify.post<{ Params: { id: string; imageId: string } }>(
    '/products/:id/images/:imageId/push-to-dam',
    async (req, reply) => {
      const { id, imageId } = req.params
      const image = await prisma.productImage.findFirst({
        where: { id: imageId, productId: id },
      })
      if (!image) return reply.status(404).send({ error: 'IMAGE_NOT_FOUND' })
      if (!image.publicId) {
        return reply.status(400).send({
          error: 'NO_PUBLIC_ID',
          message: 'Image has no Cloudinary publicId — DAM library only accepts assets we own.',
        })
      }

      const role = image.type.toLowerCase() // 'main' / 'alt' / 'lifestyle' / 'swatch' / 'diagram'

      // Reuse-or-create the DigitalAsset by storageId. Cloudinary
      // publicId is globally unique within an account.
      let asset = await prisma.digitalAsset.findFirst({
        where: { storageProvider: 'cloudinary', storageId: image.publicId },
      })
      if (!asset) {
        asset = await prisma.digitalAsset.create({
          data: {
            label: image.alt ?? image.publicId.split('/').pop() ?? image.id,
            type: 'image',
            mimeType: image.mimeType ?? 'image/jpeg',
            sizeBytes: image.fileSize ?? 0,
            storageProvider: 'cloudinary',
            storageId: image.publicId,
            url: image.url,
            metadata: {
              productImageId: image.id,
              width: image.width,
              height: image.height,
              pushedFromMaster: true,
            } as object,
          },
        })
      }

      // Reuse-or-create the AssetUsage. The unique constraint covers
      // (assetId, scope, productId, role, sortOrder) so duplicate calls
      // collide cleanly.
      const existingUsage = await prisma.assetUsage.findFirst({
        where: {
          assetId: asset.id,
          scope: 'product',
          productId: id,
          role,
        },
      })
      const usage = existingUsage ?? await prisma.assetUsage.create({
        data: {
          assetId: asset.id,
          scope: 'product',
          productId: id,
          role,
          sortOrder: image.sortOrder,
        },
      })

      return reply.send({ ok: true, asset, usage, created: !existingUsage })
    },
  )

  // ── POST /api/products/:id/images/:imageId/analyze ───────────────────
  // IR.6.2 — Run Gemini Vision on a master ProductImage, persist
  // hasWhiteBackground / frameFillPct / hasTextOverlay / offCenterScore
  // on the row. Audit hits AiUsageLog.
  fastify.post<{ Params: { id: string; imageId: string } }>(
    '/products/:id/images/:imageId/analyze',
    async (req, reply) => {
      const { id, imageId } = req.params
      const source = await prisma.productImage.findFirst({
        where: { id: imageId, productId: id },
      })
      if (!source) return reply.status(404).send({ error: 'IMAGE_NOT_FOUND' })

      try {
        const result = await analyzeProductImage({
          productImageId: source.id,
          url: source.url,
        })
        // Return the updated row so the FE can render new badges
        // without a workspace reload round-trip.
        const updated = await prisma.productImage.findUnique({ where: { id: source.id } })
        return reply.send({ ok: true, result, image: updated })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Vision analysis failed'
        return reply.status(502).send({ error: 'VISION_FAILED', message })
      }
    },
  )

  // ── POST /api/products/:id/images/generate-lifestyle ─────────────────
  // IR.14 — Imagen 3 text-to-image lifestyle generation. Operator
  // types a scene prompt, server hits Imagen via :predict, uploads
  // the base64 PNG to Cloudinary, saves a new ProductImage with
  // type=LIFESTYLE + metadata flagging it AI-generated.
  fastify.post<{
    Params: { id: string }
    Body: { prompt?: string; aspectRatio?: ImagenAspectRatio; alt?: string | null }
  }>(
    '/products/:id/images/generate-lifestyle',
    async (req, reply) => {
      const { id } = req.params
      const body = req.body ?? {}
      const prompt = (body.prompt ?? '').trim()
      if (prompt.length < 10) {
        return reply.status(400).send({
          error: 'PROMPT_TOO_SHORT',
          message: 'Prompt must be at least 10 characters — describe the scene + product context.',
        })
      }
      if (prompt.length > 2000) {
        return reply.status(400).send({
          error: 'PROMPT_TOO_LONG',
          message: 'Imagen caps prompts at ~2000 characters; trim the description.',
        })
      }

      const aspectRatio = body.aspectRatio ?? '1:1'
      if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        return reply.status(400).send({ error: 'INVALID_ASPECT_RATIO', validRatios: VALID_ASPECT_RATIOS })
      }

      const product = await prisma.product.findUnique({ where: { id }, select: { id: true } })
      if (!product) return reply.status(404).send({ error: 'PRODUCT_NOT_FOUND' })

      if (!isCloudinaryConfigured()) {
        return reply.status(503).send({ error: 'CLOUDINARY_NOT_CONFIGURED' })
      }

      try {
        const generated = await generateLifestyleImage({
          prompt,
          aspectRatio,
          entityType: 'Product',
          entityId: id,
        })

        // Imagen returns base64 PNG; push to Cloudinary so we get a
        // real URL + publicId that the rest of the workspace can use.
        const buffer = Buffer.from(generated.base64, 'base64')
        const uploaded = await uploadBufferToCloudinary(buffer, {
          folder: `product-images/${id}/ai-generated`,
        })

        const count = await prisma.productImage.count({ where: { productId: id } })

        const image = await prisma.productImage.create({
          data: {
            productId: id,
            url: uploaded.url,
            publicId: uploaded.publicId,
            type: 'LIFESTYLE',
            alt: body.alt ?? null,
            sortOrder: count,
            width: uploaded.width,
            height: uploaded.height,
            fileSize: uploaded.bytes,
            mimeType: 'image/png',
          },
        })

        return reply.status(201).send({
          ok: true,
          image,
          prompt: generated.prompt,
          aspectRatio: generated.aspectRatio,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Generation failed'
        return reply.status(502).send({ error: 'GENERATION_FAILED', message })
      }
    },
  )

  // ── DELETE /api/products/:id/images/:imageId ─────────────────────────
  fastify.delete<{ Params: { id: string; imageId: string } }>(
    '/products/:id/images/:imageId',
    async (req, reply) => {
      const { id, imageId } = req.params
      const existing = await prisma.productImage.findFirst({
        where: { id: imageId, productId: id },
      })
      if (!existing) return reply.status(404).send({ error: 'IMAGE_NOT_FOUND' })

      await prisma.productImage.delete({ where: { id: imageId } })

      // Best-effort Cloudinary cleanup
      if (existing.publicId && isCloudinaryConfigured()) {
        deleteFromCloudinary(existing.publicId).catch(() => {/* orphaned asset — acceptable */})
      }

      return reply.send({ deleted: true })
    },
  )
}

export default productImagesCrudRoutes
