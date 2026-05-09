/**
 * F5 — bulk product-image upload from a folder of files.
 *
 *   POST /api/products/images/resolve
 *     body: { filenames: string[] }
 *     → { resolutions: Array<{ filename, sku?, type?, position?, productId? }> }
 *
 *     Pure preview pass: no upload, no DB write. Lets the user see
 *     which photos will land where before paying the Cloudinary
 *     bandwidth. Unmatched filenames come back without a sku/type
 *     so the UI can flag them.
 *
 *   POST /api/products/images/upload
 *     multipart with field "file"; optional ?sku= override
 *     → { ok: true, productId, sku, type, position, url }
 *        | { ok: false, error, filename }
 *
 *     Per-file upload. The client fans out N files with concurrency
 *     limit, getting per-file progress + fault isolation (one bad
 *     filename can't stall the batch). Filename is parsed via the
 *     same resolver used by /resolve so the preview matches the
 *     write 1:1.
 *
 *     If ?sku= is provided we trust it (lets the user fix a misnamed
 *     file from the preview UI without renaming on disk). Otherwise
 *     we derive from the filename.
 *
 * Storage: Cloudinary, folder='product-images/<productId>'. URL +
 * publicId saved to ProductImage. type is bound by the resolver
 * (MAIN | ALT | LIFESTYLE) — no enforcement of single-MAIN since
 * the schema doesn't constrain it and a re-upload should be able
 * to overwrite without a manual cleanup step.
 *
 * Rate limits: resolve = 30/min (cheap, just a SKU lookup).
 * upload = 120/min — the realistic batch size is "one product
 * shoot worth" (50–200 files); at concurrency=4 client-side that
 * burns ≤120/min comfortably with retries.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../services/cloudinary.service.js'
import {
  resolveImageBatch,
  resolveImageFilename,
  type ImageSlot,
} from '../services/products/image-resolver.service.js'
import { auditLogService } from '../services/audit-log.service.js'

const MAX_RESOLVE_FILENAMES = 1000

const productsImagesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { filenames?: unknown } }>(
    '/products/images/resolve',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const raw = (request.body ?? {}).filenames
      if (!Array.isArray(raw)) {
        return reply.code(400).send({ error: 'filenames[] required' })
      }
      const filenames = raw.filter((f): f is string => typeof f === 'string')
      if (filenames.length === 0) {
        return reply.code(400).send({ error: 'filenames[] required' })
      }
      if (filenames.length > MAX_RESOLVE_FILENAMES) {
        return reply.code(400).send({
          error: `max ${MAX_RESOLVE_FILENAMES} filenames per call (got ${filenames.length})`,
        })
      }

      // Pull every SKU once. ~3,200 rows × ~20-byte string = ~64 KB,
      // so a single SELECT beats N findUniques and keeps the resolver
      // pure-functional.
      const allProducts = await prisma.product.findMany({
        select: { id: true, sku: true },
      })
      const skuToId = new Map(allProducts.map((p) => [p.sku, p.id]))
      const knownSkus = new Set(skuToId.keys())

      const batch = resolveImageBatch(filenames, knownSkus)
      const resolutions = batch.map(({ filename, resolution }) => {
        if (!resolution) {
          return { filename, ok: false as const, reason: 'no SKU match' }
        }
        const productId = skuToId.get(resolution.sku)
        return {
          filename,
          ok: true as const,
          sku: resolution.sku,
          productId,
          type: resolution.type,
          position: resolution.position,
        }
      })

      return {
        resolutions,
        summary: {
          total: resolutions.length,
          matched: resolutions.filter((r) => r.ok).length,
          unmatched: resolutions.filter((r) => !r.ok).length,
        },
      }
    },
  )

  fastify.post<{ Querystring: { sku?: string } }>(
    '/products/images/upload',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!isCloudinaryConfigured()) {
        return reply.code(503).send({
          error:
            'Cloudinary not configured — set CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET on the API server.',
        })
      }

      let part: any
      try {
        part = await (request as any).file?.()
      } catch (err) {
        return reply.code(400).send({
          error:
            err instanceof Error
              ? err.message
              : 'multipart upload required (Content-Type: multipart/form-data, field name: "file")',
        })
      }
      if (!part) {
        return reply
          .code(400)
          .send({ error: 'multipart upload required (field name: "file")' })
      }

      const filename: string = part.filename ?? 'upload'
      if (!/\.(jpe?g|png|webp|gif|tiff?|avif)$/i.test(filename)) {
        return reply.code(400).send({
          error: `unsupported image extension: ${filename}`,
          filename,
        })
      }

      const buffer: Buffer = await part.toBuffer()

      // Determine SKU — query override wins over filename derivation.
      const overrideSku = (request.query?.sku ?? '').trim()
      let sku: string
      let type: ImageSlot
      let position: number | null

      if (overrideSku) {
        sku = overrideSku
        // Try filename for slot info; fall back to ALT.
        const knownSkus = new Set([overrideSku])
        const probe = resolveImageFilename(filename, knownSkus) ?? {
          sku: overrideSku,
          type: 'ALT' as ImageSlot,
          position: null,
        }
        type = probe.type
        position = probe.position
      } else {
        const allProducts = await prisma.product.findMany({
          select: { sku: true },
        })
        const knownSkus = new Set(allProducts.map((p) => p.sku))
        const resolution = resolveImageFilename(filename, knownSkus)
        if (!resolution) {
          return reply.code(404).send({
            ok: false,
            error:
              'no SKU match in filename — pass ?sku=<id> to override or rename the file',
            filename,
          })
        }
        sku = resolution.sku
        type = resolution.type
        position = resolution.position
      }

      const product = await prisma.product.findUnique({
        where: { sku },
        select: { id: true },
      })
      if (!product) {
        return reply.code(404).send({
          ok: false,
          error: `unknown SKU: ${sku}`,
          filename,
          sku,
        })
      }

      // Cloudinary upload. publicId left unset so re-uploads with the
      // same filename don't silently overwrite — the user can review +
      // delete duplicates from the per-product editor.
      let uploaded
      try {
        uploaded = await uploadBufferToCloudinary(buffer, {
          folder: `product-images/${product.id}`,
        })
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: err instanceof Error ? err.message : 'Cloudinary upload failed',
          filename,
          sku,
        })
      }

      const created = await prisma.productImage.create({
        data: {
          productId: product.id,
          url: uploaded.url,
          alt: filename,
          type,
        },
        select: { id: true, url: true, type: true, createdAt: true },
      })

      // W4.11b — tee into DigitalAsset + AssetUsage so the W4.4
      // DAM library starts populating organically. Wrapped in
      // try/catch: ProductImage is still the legacy source of
      // truth; a DAM-side failure must NOT break the legacy upload
      // path. Once W4.12 backfills history + W4.7 cuts over, the
      // ProductImage write becomes optional.
      try {
        const mimeType = uploaded.format
          ? `image/${uploaded.format}`
          : 'image/jpeg'
        const asset = await prisma.digitalAsset.create({
          data: {
            label: filename,
            type: 'image',
            mimeType,
            sizeBytes: uploaded.bytes,
            storageProvider: 'cloudinary',
            storageId: uploaded.publicId,
            url: uploaded.url,
            originalFilename: filename,
            metadata: {
              width: uploaded.width,
              height: uploaded.height,
              productImageId: created.id,
            },
          },
          select: { id: true },
        })
        await prisma.assetUsage.create({
          data: {
            assetId: asset.id,
            scope: 'product',
            productId: product.id,
            role: type.toLowerCase(), // 'main' | 'alt' | 'lifestyle'
            sortOrder: position,
          },
        })
      } catch (err) {
        // Log + continue — DAM is best-effort on the legacy path.
        fastify.log.warn(
          { err, productId: product.id, filename, source: 'W4.11b-dam-tee' },
          'DAM tee failed; ProductImage still wrote successfully',
        )
      }

      auditLogService.write({
        userId: 'default-user',
        entityType: 'Product',
        entityId: product.id,
        action: 'create',
        after: {
          imageId: created.id,
          type,
          source: 'bulk-image-upload',
          filename,
          position,
        },
        metadata: {
          source: 'products-images-upload',
          sku,
          publicId: uploaded.publicId,
          width: uploaded.width,
          height: uploaded.height,
          bytes: uploaded.bytes,
        },
      })

      return {
        ok: true as const,
        productId: product.id,
        sku,
        type,
        position,
        url: created.url,
        imageId: created.id,
        filename,
      }
    },
  )
}

export default productsImagesRoutes
