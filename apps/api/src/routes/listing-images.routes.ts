/**
 * C.11 — ListingImage CRUD for the dedicated /products/:id/images page.
 *
 * The wizard's Step 7 has linked to /products/:id/images since launch
 * but the page never existed (404). This route + the matching client
 * page complete the architecture: wizard does quick master-gallery
 * reorder; this page handles per-variant + per-scope overrides.
 *
 * Endpoints:
 *
 *   GET    /api/products/:productId/listing-images
 *     → { master: ProductImage[], overrides: ListingImage[], variants: VariantSummary[] }
 *
 *   POST   /api/products/:productId/listing-images
 *     body: { url, filename?, scope, platform?, marketplace?, variationId?, role?, sourceProductImageId? }
 *     → { listingImage: ListingImage }
 *
 *   PATCH  /api/listing-images/:id
 *     body: { scope?, platform?, marketplace?, role?, position? }
 *     → { listingImage: ListingImage }
 *
 *   POST   /api/products/:productId/listing-images/reorder
 *     body: { bucket: { variationId?, scope, platform?, marketplace? }, ids: string[] }
 *     → { reordered: number }
 *
 *   DELETE /api/listing-images/:id
 *     → { success: true }
 *
 * Multi-scope semantics enforce required fields by scope:
 *   - GLOBAL:      platform=null, marketplace=null
 *   - PLATFORM:    platform required, marketplace=null
 *   - MARKETPLACE: platform required, marketplace required
 *
 * variationId is independent of scope — null = product-level override,
 * set = variation-specific override. The resolution cascade in
 * ImageResolutionService walks 7 levels (variation × scope) so any
 * combination of (variation, scope) is meaningful.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

type ImageScope = 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
type ImageRole =
  | 'MAIN'
  | 'GALLERY'
  | 'INFOGRAPHIC'
  | 'LIFESTYLE'
  | 'SIZE_CHART'
  | 'SWATCH'

const VALID_SCOPES: ReadonlySet<ImageScope> = new Set([
  'GLOBAL',
  'PLATFORM',
  'MARKETPLACE',
])
const VALID_ROLES: ReadonlySet<ImageRole> = new Set([
  'MAIN',
  'GALLERY',
  'INFOGRAPHIC',
  'LIFESTYLE',
  'SIZE_CHART',
  'SWATCH',
])

/**
 * Validate (scope, platform, marketplace) shape per the schema's
 * required-field rules. Returns null when valid, an error string
 * otherwise — the route handler 400s with the message.
 */
function validateScopeFields(
  scope: ImageScope,
  platform: string | null | undefined,
  marketplace: string | null | undefined,
): string | null {
  if (scope === 'GLOBAL') {
    if (platform || marketplace) {
      return 'GLOBAL scope must not include platform or marketplace'
    }
    return null
  }
  if (scope === 'PLATFORM') {
    if (!platform) return 'PLATFORM scope requires platform'
    if (marketplace) return 'PLATFORM scope must not include marketplace'
    return null
  }
  if (scope === 'MARKETPLACE') {
    if (!platform) return 'MARKETPLACE scope requires platform'
    if (!marketplace) return 'MARKETPLACE scope requires marketplace'
    return null
  }
  return `Unknown scope: ${scope}`
}

const listingImagesRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /api/products/:productId/listing-images ─────────────────
  // Returns the master gallery + every ListingImage row for the
  // product, plus a summary of variants. The client groups rows
  // by (variationId, scope, platform, marketplace) for the editor.
  fastify.get<{ Params: { productId: string } }>(
    '/products/:productId/listing-images',
    async (request, reply) => {
      const { productId } = request.params
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, sku: true, name: true, isParent: true },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }

      const [master, overrides, variants] = await Promise.all([
        prisma.productImage.findMany({
          where: { productId },
          orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            url: true,
            alt: true,
            type: true,
            createdAt: true,
          },
        }),
        prisma.listingImage.findMany({
          where: { productId },
          orderBy: [{ scope: 'asc' }, { position: 'asc' }],
        }),
        // Children (when isParent) — surface their SKU + variant
        // attributes so the editor can present "override images for
        // this variant" rows. Returns empty for non-parent products.
        product.isParent
          ? prisma.product.findMany({
              where: { parentId: productId },
              orderBy: { sku: 'asc' },
              select: {
                id: true,
                sku: true,
                name: true,
                variantAttributes: true,
              },
            })
          : Promise.resolve([]),
      ])

      return { product, master, overrides, variants }
    },
  )

  // ── POST /api/products/:productId/listing-images ────────────────
  // Create a new ListingImage row. Two patterns:
  //   1. Reference an existing master image: pass sourceProductImageId
  //      + url. The client copies the URL from the master gallery
  //      so the override can be re-edited without re-uploading.
  //   2. Direct: pass url for a freshly-uploaded image (the upload
  //      itself goes through /api/products/images/upload — this
  //      endpoint just records the listing-image metadata).
  fastify.post<{
    Params: { productId: string }
    Body: {
      url: string
      filename?: string | null
      scope: ImageScope
      platform?: string | null
      marketplace?: string | null
      variationId?: string | null
      role?: ImageRole
      sourceProductImageId?: string | null
      position?: number
    }
  }>(
    '/products/:productId/listing-images',
    async (request, reply) => {
      const { productId } = request.params
      const body = request.body ?? ({} as any)
      if (typeof body.url !== 'string' || body.url.length === 0) {
        return reply.code(400).send({ error: 'url required' })
      }
      const scope = body.scope as ImageScope
      if (!VALID_SCOPES.has(scope)) {
        return reply
          .code(400)
          .send({ error: `Invalid scope: ${scope}` })
      }
      const role: ImageRole = body.role && VALID_ROLES.has(body.role)
        ? body.role
        : 'GALLERY'

      const platform = body.platform
        ? String(body.platform).toUpperCase()
        : null
      const marketplace = body.marketplace
        ? String(body.marketplace).toUpperCase()
        : null
      const scopeError = validateScopeFields(scope, platform, marketplace)
      if (scopeError) {
        return reply.code(400).send({ error: scopeError })
      }

      // Position: if unspecified, append to the bucket. Bucket is
      // the (productId, variationId, scope, platform, marketplace)
      // tuple per the @@index in schema.prisma.
      let position = body.position
      if (typeof position !== 'number' || !Number.isFinite(position)) {
        const last = await prisma.listingImage.findFirst({
          where: {
            productId,
            variationId: body.variationId ?? null,
            scope,
            platform,
            marketplace,
          },
          orderBy: { position: 'desc' },
          select: { position: true },
        })
        position = (last?.position ?? -1) + 1
      }

      try {
        const created = await prisma.listingImage.create({
          data: {
            productId,
            variationId: body.variationId ?? null,
            scope,
            platform,
            marketplace,
            url: body.url,
            filename: body.filename ?? null,
            role,
            position,
            sourceProductImageId: body.sourceProductImageId ?? null,
          },
        })
        return { listingImage: created }
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // ── PATCH /api/listing-images/:id ───────────────────────────────
  // Update scope/role/position. scope changes re-validate against
  // the platform/marketplace fields that come along with them.
  fastify.patch<{
    Params: { id: string }
    Body: {
      scope?: ImageScope
      platform?: string | null
      marketplace?: string | null
      role?: ImageRole
      position?: number
    }
  }>('/listing-images/:id', async (request, reply) => {
    const existing = await prisma.listingImage.findUnique({
      where: { id: request.params.id },
    })
    if (!existing) {
      return reply.code(404).send({ error: 'ListingImage not found' })
    }
    const body = request.body ?? ({} as any)

    const data: Record<string, unknown> = {}
    if (body.scope !== undefined) {
      if (!VALID_SCOPES.has(body.scope)) {
        return reply
          .code(400)
          .send({ error: `Invalid scope: ${body.scope}` })
      }
      data.scope = body.scope
    }
    if (body.platform !== undefined) {
      data.platform = body.platform
        ? String(body.platform).toUpperCase()
        : null
    }
    if (body.marketplace !== undefined) {
      data.marketplace = body.marketplace
        ? String(body.marketplace).toUpperCase()
        : null
    }
    if (body.role !== undefined) {
      if (!VALID_ROLES.has(body.role)) {
        return reply
          .code(400)
          .send({ error: `Invalid role: ${body.role}` })
      }
      data.role = body.role
    }
    if (typeof body.position === 'number' && Number.isFinite(body.position)) {
      data.position = body.position
    }

    // Re-validate the resulting (scope, platform, marketplace) tuple.
    const finalScope = (data.scope ?? existing.scope) as ImageScope
    const finalPlatform =
      'platform' in data ? (data.platform as string | null) : existing.platform
    const finalMarketplace =
      'marketplace' in data
        ? (data.marketplace as string | null)
        : existing.marketplace
    const scopeError = validateScopeFields(
      finalScope,
      finalPlatform,
      finalMarketplace,
    )
    if (scopeError) {
      return reply.code(400).send({ error: scopeError })
    }

    const updated = await prisma.listingImage.update({
      where: { id: request.params.id },
      data,
    })
    return { listingImage: updated }
  })

  // ── POST /api/products/:productId/listing-images/reorder ────────
  // Bulk-replace position within a (variationId, scope, platform,
  // marketplace) bucket. ids[] is the new order; index in the array
  // becomes the row's position. Rows in the bucket not present in
  // ids[] are left untouched (defensive — caller should pass the
  // complete bucket).
  fastify.post<{
    Params: { productId: string }
    Body: {
      bucket: {
        variationId?: string | null
        scope: ImageScope
        platform?: string | null
        marketplace?: string | null
      }
      ids: string[]
    }
  }>(
    '/products/:productId/listing-images/reorder',
    async (request, reply) => {
      const { productId } = request.params
      const body = request.body ?? ({} as any)
      const bucket = body.bucket
      if (!bucket || !VALID_SCOPES.has(bucket.scope)) {
        return reply.code(400).send({ error: 'bucket.scope required' })
      }
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return reply.code(400).send({ error: 'ids[] required' })
      }
      const platform = bucket.platform
        ? String(bucket.platform).toUpperCase()
        : null
      const marketplace = bucket.marketplace
        ? String(bucket.marketplace).toUpperCase()
        : null
      const scopeError = validateScopeFields(
        bucket.scope,
        platform,
        marketplace,
      )
      if (scopeError) {
        return reply.code(400).send({ error: scopeError })
      }

      // Update each position transactionally — small N so a $transaction
      // array is fine. Could be a single SQL with CASE if N grows.
      const ops = body.ids.map((id, idx) =>
        prisma.listingImage.updateMany({
          where: {
            id,
            productId,
            variationId: bucket.variationId ?? null,
            scope: bucket.scope,
            platform,
            marketplace,
          },
          data: { position: idx },
        }),
      )
      const results = await prisma.$transaction(ops)
      const reordered = results.reduce((s, r) => s + r.count, 0)
      return { reordered }
    },
  )

  // ── DELETE /api/listing-images/:id ──────────────────────────────
  // Removes the override row only — the master ProductImage gallery
  // is untouched. A deleted row falls back to the next-most-general
  // scope (or master) on the next resolution.
  fastify.delete<{ Params: { id: string } }>(
    '/listing-images/:id',
    async (request, reply) => {
      const existing = await prisma.listingImage.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'ListingImage not found' })
      }
      await prisma.listingImage.delete({ where: { id: request.params.id } })
      return { success: true }
    },
  )
}

export default listingImagesRoutes
