/**
 * F4 — bulk AI content generation for /products grid.
 *
 *   POST /api/products/ai/bulk-generate
 *     body: { productIds: string[]; fields: ContentField[]; marketplace: string; dryRun?: boolean }
 *     → { results: Array<{ productId, ok, generated?, error? }> }
 *
 * Loops the requested products, calls the same ListingContentService
 * the listing wizard uses (so quality + terminology + per-language
 * prompts are identical), and either writes the result back to
 * Product columns immediately or returns a dry-run preview.
 *
 * Writes go through PATCH /api/products/bulk's same code path
 * conceptually — direct prisma.product.update for fields that don't
 * cascade (description, bulletPoints, keywords). Title is written
 * to Product.name only when explicitly requested.
 *
 * Returns 503 when GEMINI_API_KEY isn't set so the client can show
 * a helpful message instead of hanging.
 *
 * Per-product errors don't fail the whole batch — each is returned
 * in the results array with `ok: false` + `error` so the UI can
 * highlight the failures and let the user retry.
 *
 * Rate limit: 5 requests/min. Each call can fan out to many
 * products + many fields, so the limit is set low to keep AI cost
 * + Gemini quota predictable. Caller should batch productIds rather
 * than call once per product.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { GeminiService } from '../services/ai/gemini.service.js'
import {
  ListingContentService,
  type ContentField,
  type GenerationResult,
} from '../services/ai/listing-content.service.js'
import { auditLogService } from '../services/audit-log.service.js'

const ALLOWED_FIELDS = new Set<ContentField>([
  'title',
  'bullets',
  'description',
  'keywords',
])
const MAX_PRODUCTS_PER_CALL = 50

const gemini = new GeminiService()
const service = new ListingContentService(gemini)

interface BulkGenerateBody {
  productIds?: string[]
  fields?: string[]
  marketplace?: string
  /** When true, return generated content but skip the write. */
  dryRun?: boolean
}

interface BulkGenerateResult {
  productId: string
  ok: boolean
  generated?: GenerationResult
  /** Fields actually written when dryRun=false. */
  written?: ContentField[]
  error?: string
}

const productsAiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: BulkGenerateBody }>(
    '/products/ai/bulk-generate',
    {
      // F4 — AI fan-out is cheap on the server side (Gemini does the
      // heavy lift) but billable per call. Keep the rate limit tight
      // so a stuck client retry loop can't pin Gemini quota.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!service.isConfigured()) {
        return reply.code(503).send({
          error:
            'Gemini API not configured — set GEMINI_API_KEY on the API server.',
        })
      }

      const body = request.body ?? {}
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      const marketplace = (body.marketplace ?? '').trim().toUpperCase()
      const requestedFieldsRaw = Array.isArray(body.fields) ? body.fields : []
      const dryRun = body.dryRun === true

      if (productIds.length === 0) {
        return reply.code(400).send({ error: 'productIds[] required' })
      }
      if (productIds.length > MAX_PRODUCTS_PER_CALL) {
        return reply.code(400).send({
          error: `max ${MAX_PRODUCTS_PER_CALL} products per call (got ${productIds.length}); split into smaller batches`,
        })
      }
      if (!marketplace) {
        return reply.code(400).send({ error: 'marketplace required' })
      }
      const requestedFields = requestedFieldsRaw.filter(
        (f): f is ContentField => ALLOWED_FIELDS.has(f as ContentField),
      )
      if (requestedFields.length === 0) {
        return reply.code(400).send({
          error: `fields must include one or more of ${Array.from(ALLOWED_FIELDS).join(', ')}`,
        })
      }

      // Pre-fetch all products in one query so the loop only does AI
      // work + (if writing) one update per product.
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          sku: true,
          name: true,
          brand: true,
          description: true,
          bulletPoints: true,
          keywords: true,
          weightValue: true,
          weightUnit: true,
          dimLength: true,
          dimWidth: true,
          dimHeight: true,
          dimUnit: true,
          productType: true,
          variantAttributes: true,
          categoryAttributes: true,
        },
      })
      const byId = new Map(products.map((p) => [p.id, p]))

      // Per-brand+marketplace terminology — fetched once for the
      // batch since most batches share a brand. brand=null rows
      // apply to every brand on the marketplace.
      const distinctBrands = Array.from(
        new Set(products.map((p) => p.brand).filter((b): b is string => !!b)),
      )
      const terminologyRows = await prisma.terminologyPreference.findMany({
        where: {
          marketplace,
          OR: [
            { brand: null },
            ...(distinctBrands.length > 0
              ? [{ brand: { in: distinctBrands } }]
              : []),
          ],
        },
        select: { brand: true, preferred: true, avoid: true, context: true },
      })
      const terminologyByBrand = new Map<string | null, typeof terminologyRows>()
      for (const t of terminologyRows) {
        const arr = terminologyByBrand.get(t.brand) ?? []
        arr.push(t)
        terminologyByBrand.set(t.brand, arr)
      }

      const results: BulkGenerateResult[] = []
      for (const id of productIds) {
        const product = byId.get(id)
        if (!product) {
          results.push({ productId: id, ok: false, error: 'Product not found' })
          continue
        }

        try {
          const terminology = [
            ...(terminologyByBrand.get(product.brand) ?? []),
            ...(terminologyByBrand.get(null) ?? []),
          ].map((t) => ({
            preferred: t.preferred,
            avoid: t.avoid,
            context: t.context,
          }))

          const generated = await service.generate({
            product: {
              id: product.id,
              sku: product.sku,
              name: product.name,
              brand: product.brand,
              description: product.description,
              bulletPoints: product.bulletPoints ?? [],
              keywords: product.keywords ?? [],
              weightValue:
                product.weightValue != null ? Number(product.weightValue) : null,
              weightUnit: product.weightUnit,
              dimLength:
                product.dimLength != null ? Number(product.dimLength) : null,
              dimWidth:
                product.dimWidth != null ? Number(product.dimWidth) : null,
              dimHeight:
                product.dimHeight != null ? Number(product.dimHeight) : null,
              dimUnit: product.dimUnit,
              productType: product.productType,
              variantAttributes: product.variantAttributes,
              categoryAttributes: product.categoryAttributes,
            },
            marketplace,
            fields: requestedFields,
            terminology,
          })

          let written: ContentField[] = []
          if (!dryRun) {
            // Write back to Product columns. Title goes to name only
            // if explicitly requested (most users want AI to refresh
            // description/bullets/keywords without also rewriting
            // their canonical name). description, bullets, keywords
            // map cleanly to Product columns.
            const updateData: Record<string, unknown> = {
              version: { increment: 1 },
            }
            if (generated.title && requestedFields.includes('title')) {
              updateData.name = generated.title.content
              written.push('title')
            }
            if (generated.description) {
              updateData.description = generated.description.content
              written.push('description')
            }
            if (generated.bullets) {
              updateData.bulletPoints = generated.bullets.content
              written.push('bullets')
            }
            if (generated.keywords) {
              // keywords come back as a comma-separated string from
              // Gemini per the prompt; Product.keywords is String[]
              // so we split and trim.
              updateData.keywords = generated.keywords.content
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean)
              written.push('keywords')
            }
            if (Object.keys(updateData).length > 1) {
              await prisma.product.update({
                where: { id },
                data: updateData,
              })
              // Audit row so the activity tab (F3) shows the AI write
              // attributed to the source.
              auditLogService.write({
                userId: 'ai',
                entityType: 'Product',
                entityId: id,
                action: 'update',
                after: { fields: written, marketplace },
                metadata: {
                  source: 'products-ai-bulk',
                  marketplace,
                  fields: written,
                  model: generated.metadata.model,
                  language: generated.metadata.language,
                },
              })
            }
          }

          results.push({
            productId: id,
            ok: true,
            generated,
            written: dryRun ? [] : written,
          })
        } catch (err) {
          results.push({
            productId: id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return {
        results,
        summary: {
          total: results.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          dryRun,
        },
      }
    },
  )
}

export default productsAiRoutes
