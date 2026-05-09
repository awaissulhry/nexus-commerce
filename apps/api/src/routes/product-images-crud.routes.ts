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
  deleteFromCloudinary,
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../services/cloudinary.service.js'

const VALID_TYPES = new Set(['MAIN', 'ALT', 'LIFESTYLE', 'SWATCH', 'DIAGRAM'])

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
