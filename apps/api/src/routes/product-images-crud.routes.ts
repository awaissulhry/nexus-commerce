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
